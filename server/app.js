/**
 * Express 应用装配（不含 listen）。
 *
 * 为什么要把「建 app」和「监听端口」拆开：
 *   本地/自有服务器需要一个长驻进程（server/index.js 里 app.listen）；
 *   Vercel 是无服务器环境，不能长驻监听，只需要导出一个可调用的 app
 *   （api/index.js 里 export default）。两边共用同一份装配逻辑，
 *   避免「本地能跑、线上 404」这类分叉。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import dotenv from "dotenv";
import express from "express";

import productsRoutes from "./routes/products.js";
import selectionRoutes from "./routes/selection.js";
import { pingDb } from "./db.js";
import { inboxBackend } from "./lib/inboxStore.js";
import { AppError } from "./lib/errors.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

/** 是否跑在 Vercel 上（Vercel 会自动注入 VERCEL=1） */
export const IS_VERCEL = Boolean(process.env.VERCEL);

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // 部署到 Vercel 时请求经过它的代理，必须开 trust proxy，
  // 否则 req.protocol 永远是 http，生成的采集脚本地址会是 http://…
  // 而脚本跑在 samsclub.com（https）里，混合内容会被浏览器直接拦掉。
  app.set("trust proxy", true);

  app.use(cors());
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", async (_req, res) => {
    const db = await pingDb();
    res.json({
      ok: true,
      data: {
        uptime: Math.round(process.uptime()),
        database: db.ok ? "ok" : "not_ready",
        databaseDetail: db.message,
        // memory = 单实例内存；redis = 多实例共享（Vercel 上建议配）
        inbox: inboxBackend(),
        runtime: IS_VERCEL ? "vercel" : "node",
        env: process.env.NODE_ENV || "development",
      },
    });
  });

  app.use("/api/products", productsRoutes);
  app.use("/api/selection", selectionRoutes);

  // 未匹配的 /api/* 一律返回 JSON 404，别把 Express 默认的 HTML 错误页返给前端
  app.use("/api", (req, res) => {
    res.status(404).json({
      ok: false,
      error: {
        code: "API_NOT_FOUND",
        message: `接口不存在：${req.method} ${req.originalUrl}`,
        hint: "可用接口：GET /api/health、GET /api/products/channels、GET /api/products/search、GET/POST /api/selection、POST /api/selection/remove、POST /api/selection/clear",
      },
    });
  });

  // 静态资源：只在「自带前端的单端口部署」时由 Express 提供。
  // Vercel 上前端由它的 CDN 直接发（vercel.json 里 outputDirectory=dist），
  // 不需要也不应该把 dist 塞进函数包，所以这里跳过。
  const distDir = path.join(projectRoot, "dist");
  if (!IS_VERCEL && fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false, maxAge: "1h" }));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  // 统一错误出口：错误信息里绝不带内部堆栈或密钥
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.status : 500;
    if (status >= 500) {
      console.error(`[error] ${err?.stack || err}`);
    }
    res.status(status).json({
      ok: false,
      error: {
        code: err?.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"),
        message: err instanceof AppError ? err.message : "服务内部错误，请稍后重试",
        hint: err?.hint || "",
      },
    });
  });

  return app;
}
