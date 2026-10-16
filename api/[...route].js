/**
 * /api/** 的文件系统通配路由。
 *
 * 有它在，/api/products/channels 这类路径会由 Vercel 的路由层直接命中本函数
 * （不需要经过 vercel.json 的 rewrite），req.url 一定是原始路径，最稳。
 * 具体的处理逻辑与 api/index.js 完全一致，这里只是复用。
 *
 * 即使某些运行时不吃 `[...route]` 这种写法，vercel.json 里的
 * `/api/:path* → /api` 重写也能兜住，两条路互为保险。
 */

export { default } from "./index.js";
