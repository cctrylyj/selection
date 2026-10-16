/**
 * Bright Data Web Unlocker API。
 * 让官方数据服务商去处理站点风控，我们只发请求、收内容 —— 不在自己进程里跑浏览器。
 *
 * 文档：https://docs.brightdata.com/scraping-automation/web-unlocker/send-your-first-unlocker-request
 */

import { getEnv, requireEnv } from "../../lib/env.js";
import { ChannelError } from "../../lib/errors.js";

const ENDPOINT = "https://api.brightdata.com/request";

export function isWebUnlockerConfigured() {
  return Boolean(getEnv("BRIGHTDATA_API_TOKEN"));
}

/**
 * @param {string} url 目标页面
 * @param {{format?: "raw"|"json", timeoutMs?: number, method?: string, payload?: string}} opts
 * @returns {Promise<{status:number, headers:Record<string,string>, body:string, json:any}>}
 */
export async function webUnlockerRequest(url, opts = {}) {
  const token = requireEnv(
    "BRIGHTDATA_API_TOKEN",
    "Bright Data 控制台 → Account settings → API tokens 创建后填入 .env。"
  );
  const zone = getEnv("BRIGHTDATA_ZONE", "web_unblocker1");
  const timeoutMs = opts.timeoutMs ?? 60000;

  const body = {
    zone,
    url,
    format: opts.format ?? "raw",
  };
  if (opts.method) body.method = opts.method;
  if (opts.payload) body.payload = opts.payload;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const why = e instanceof Error && e.name === "AbortError" ? "请求超时" : (e?.message || String(e));
    throw new ChannelError("Bright Data Web Unlocker 请求失败", why);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new ChannelError(
      `Bright Data Web Unlocker 返回 HTTP ${res.status}`,
      `${raw.slice(0, 300)} —— 常见原因：zone 名写错、token 失效、余额不足。`
    );
  }

  if ((opts.format ?? "raw") === "json") {
    try {
      return { status: res.status, headers: res.headers, body: raw, json: JSON.parse(raw) };
    } catch {
      throw new ChannelError("Bright Data 返回的不是合法 JSON", raw.slice(0, 300));
    }
  }
  return { status: res.status, headers: res.headers, body: raw, json: null };
}

/** 便捷封装：拿 HTML，失败时给出可读原因 */
export async function webUnlockerHtml(url, opts = {}) {
  const { body } = await webUnlockerRequest(url, { ...opts, format: "raw" });
  if (!body || body.length < 200) {
    throw new ChannelError(
      `抓取到的内容过短（${body?.length ?? 0} 字节），可能被风控拦截`,
      "目标：${url}。可尝试更换 zone 或联系数据服务商确认该站点是否在支持列表。"
    );
  }
  return body;
}
