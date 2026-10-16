/**
 * 等待 Web 服务就绪，然后用 Chrome 打开系统。
 *
 * 为什么不用 Vite 的 server.open：把 Chrome 完整路径传给 server.open，
 * Vite 会把它当 URL 解析并崩溃（Protocol "c:" not supported）；传浏览器名
 * 又依赖 Windows 的协议关联。这里直接 spawn chrome.exe，最稳。
 *
 * 由 npm run dev 的第三个并发任务调用。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const url = process.argv[2] || "http://127.0.0.1:5173/";
const TIMEOUT_MS = Number(process.env.OPEN_TIMEOUT || 60000);
const INTERVAL_MS = 400;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA.replace(/\\/g, "/")}/Google/Chrome/Application/chrome.exe`
    : "",
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));

async function waitReady() {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 304) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  return false;
}

const ready = await waitReady();
if (!ready) {
  console.error(`[open] 等待 ${url} 就绪超时（${TIMEOUT_MS / 1000}s），未打开浏览器`);
  process.exit(0); // 不影响已在跑的服务
}

if (!chrome) {
  console.error("[open] 未找到 Chrome，退回系统默认浏览器");
  spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
  process.exit(0);
}

const r = spawnSync(chrome, [url], { detached: true, stdio: "ignore" });
if (r.error) {
  console.error(`[open] 启动 Chrome 失败：${r.error.message}`);
  process.exit(0);
}
r.child?.unref();
console.log(`[open] 已在 Chrome 打开 ${url}`);
