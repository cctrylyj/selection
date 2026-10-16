import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = Number(process.env.API_PORT || 8787);
// 本地开发一律走 127.0.0.1（用户约定）；仅部署态（DEPLOY_TARGET）才监听 0.0.0.0
// 注意：不能用 PORT 判断部署，因为 .env 里也会写 PORT
const isDeploy = Boolean(process.env.DEPLOY_TARGET);

// 注意：不要把 server.open 配成 Chrome 的完整 exe 路径——Vite 会把它当 URL 解析并崩溃
// （TypeError [ERR_INVALID_PROTOCOL]: Protocol "c:" not supported）。
// 「启动后自动用 Chrome 打开」由 npm run dev 里的 scripts/open-when-ready.mjs 负责：
// 它直接 spawn chrome.exe，不经过 open 包，稳定可靠。

export default defineConfig({
  plugins: [react()],
  server: {
    host: isDeploy ? "0.0.0.0" : "127.0.0.1",
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: isDeploy ? "0.0.0.0" : "127.0.0.1",
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
