/**
 * Vercel Serverless 入口。
 *
 * 本文件不启动端口监听，只把装配好的 Express 应用导出成一个函数。
 * vercel.json 里把 /api/:path* 重写到本函数（同时 api/[...route].js 提供
 * 文件系统通配路由作为主路径），前端静态资源由 Vercel 的 CDN 直接发。
 *
 * 与本地长驻服务（server/index.js）共用 server/app.js，避免两边行为分叉。
 */

import { createApp } from "../server/app.js";

// 函数实例会被复用：app 只在实例冷启动时装配一次
const app = createApp();

/**
 * 把请求路径规整成 Express 认识的形式（一定带 /api 前缀）。
 *
 * 为什么需要：rewrite 到本函数时，不同运行时下 req.url 可能是
 * 原始路径（/api/products/channels），也可能只剩重写目标（/api）。
 * 这里统一补齐前缀，保证 server/app.js 里挂载的 /api/xxx 路由能命中。
 */
function withApiPrefix(raw) {
  const u = raw && raw.startsWith("/") ? raw : `/${raw || ""}`;
  if (u === "/api" || u.startsWith("/api/") || u.startsWith("/api?")) return u;
  return `/api${u}`;
}

export default function handler(req, res) {
  req.url = withApiPrefix(req.url);
  return app(req, res);
}
