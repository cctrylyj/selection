/**
 * 本地 / 自有服务器入口：Express API + 前端静态资源，一个端口搞定。
 *  开发态：npm run dev（API 8787 + Vite 5173，Vite 代理 /api）
 *  生产态：npm run build && npm start（单端口，PORT 可覆盖）
 *
 * 部署到 Vercel 时走的是 api/index.js（serverless），不会执行本文件。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { resetInbox } from "./services/localCollect.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "..", "dist");

// 采集收件箱是「还没确认要不要」的临时数据：长驻进程重启就清空，
// 用户重新打开系统看到的是一张空列表，而不是上次会话遗留的来路不明的商品。
// （Vercel 是 serverless，冷启动时机不可控，所以只在本地长驻服务里做这件事）
await resetInbox();

// 本地默认 127.0.0.1（按用户约定）；仅部署态显式声明 DEPLOY_TARGET 才监听 0.0.0.0
// 注意：不能用 PORT 判断部署，因为 .env 里也会写 PORT
const isDeploy = Boolean(process.env.DEPLOY_TARGET);
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || (isDeploy ? "0.0.0.0" : "127.0.0.1");

const app = createApp();

app.listen(port, host, () => {
  const shown = host === "0.0.0.0" ? `http://0.0.0.0:${port}` : `http://127.0.0.1:${port}`;
  console.log(`[server] API + 静态资源已启动: ${shown}`);
  if (!fs.existsSync(distDir)) {
    console.log("[server] 未检测到 dist/，前端请另跑 npm run dev（Vite 会自动代理 /api）");
  }
});
