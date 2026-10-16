/**
 * 用 Chrome 打开系统地址。
 *
 * 用户要求「每次都在谷歌打开」——Vite 的 server.open 已经负责启动时自动打开，
 * 这个脚本用于补上另一种情况：服务已经在跑、但当前浏览器不是 Chrome 时，
 * 或者浏览器被关掉了想再打开一次。
 *
 *   npm run open:chrome [url]
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const url = process.argv[2] || "http://127.0.0.1:5173/";

const candidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA.replace(/\\/g, "/")}/Google/Chrome/Application/chrome.exe`
    : "",
].filter(Boolean);

const chrome = candidates.find((p) => existsSync(p));

if (chrome) {
  const r = spawnSync(chrome, [url], { detached: true, stdio: "ignore" });
  if (r.error) {
    console.error(`直接启动 Chrome 失败：${r.error.message}`);
    process.exit(1);
  }
  r.child?.unref();
  console.log(`已在 Chrome 打开：${url}`);
} else {
  // 退回用 Windows 的 start 关联 Chrome 协议名
  const r = spawnSync("cmd", ["/c", "start", "chrome", url], { stdio: "ignore" });
  if (r.error) {
    console.error("未找到 Chrome，且无法通过 start 命令打开。");
    process.exit(1);
  }
  console.log(`已请求用 Chrome 打开：${url}`);
}
