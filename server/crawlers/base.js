/** 适配器公共工具：商品字段归一化、HTTP、JSON-LD 抽取。 */

import { ChannelError } from "../lib/errors.js";

export const CHANNEL_IDS = ["samsclub", "amazon", "tiktokshop"];

/** 把不同渠道的原始返回拍平成统一商品结构 */
export function normalizeProduct(raw) {
  const channel = String(raw?.channel || "").trim();
  const channelKey = String(raw?.channelKey ?? "").trim();
  const productName = String(raw?.productName ?? "").trim();

  if (!channel) throw new ChannelError("商品缺少 channel 字段");
  if (!channelKey) throw new ChannelError(`商品缺少渠道内唯一键（channelKey）: ${productName || "未知商品"}`);
  if (!productName) throw new ChannelError(`商品缺少名称: ${channelKey}`, "请检查解析规则是否与目标站点改版前一致");

  // 注意：不能用 Number(null)（会得到 0），必须显式判空
  const rawPrice = raw?.price;
  const priceNum = rawPrice === null || rawPrice === undefined || rawPrice === ""
    ? null
    : Number(rawPrice);
  const price = Number.isFinite(priceNum) ? Number(priceNum.toFixed(2)) : null;

  // 销量 / 评价数：页面上给的就是整数（"6,754" / "1.2K"），统一归成非负整数。
  // 取不到就是 null，不要用 0 冒充——0 会被排序当成「真的没人买」。
  const sales = toCount(raw?.sales);

  return {
    channel,
    channelKey,
    productName,
    category: String(raw?.category ?? "").trim().slice(0, 500),
    price,
    currency: String(raw?.currency ?? "USD").trim().toUpperCase() || "USD",
    sales,
    imageUrl: String(raw?.imageUrl ?? "").trim(),
    productUrl: String(raw?.productUrl ?? "").trim(),
    description: String(raw?.description ?? "").trim().slice(0, 2000),
    source: String(raw?.source ?? "remote").trim() || "remote",
  };
}

/**
 * 销量 / 评价数的归一化：把 "6,754" / "6754 条评价" / "1.2K" / 1234 都变成整数。
 * 页面侧（collectorDom.countOf）已经处理过一次，这里是服务端侧的兜底，
 * 用于在线检索（官方 API 返回 rating_count 之类）与粘贴导入的裸字段。
 */
export function toCount(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  const s = String(v).replace(/\s+/g, "");
  const m = s.match(/^\(?(\d[\d,]*)(?:\.(\d+))?(K|k|M|m|万)?\)?$/);
  if (!m) return null;
  const suffix = m[3] || "";
  if (!suffix && m[2] !== undefined) return null; // 4.6 是星级评分，不是数量
  let num = Number(m[1].replace(/,/g, "") + (m[2] ? "." + m[2] : ""));
  if (!Number.isFinite(num) || num <= 0) return null;
  if (suffix === "K" || suffix === "k") num *= 1000;
  else if (suffix === "M" || suffix === "m") num *= 1000000;
  else if (suffix === "万") num *= 10000;
  return Math.round(num);
}

export function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

export function cleanText(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** 从对象里按候选键名取第一个非空值（大小写敏感，用于已知结构） */
export function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export async function fetchJson(url, { method = "POST", headers = {}, body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const why = e instanceof Error && e.name === "AbortError" ? "请求超时" : (e?.message || String(e));
    throw new ChannelError(`网络请求失败：${url}`, why);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text.slice(0, 500) };
  }

  if (!res.ok) {
    const detail = data?._raw || JSON.stringify(data).slice(0, 300);
    throw new ChannelError(
      `上游返回 HTTP ${res.status}`,
      `响应片段：${detail}。若是签名/凭证问题，请核对配置与官方文档。`
    );
  }
  return data;
}

/** 从 HTML 里找 schema.org/Product 的 JSON-LD 块 */
export function extractJsonLdProduct(html) {
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const inner = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim();
    let data = null;
    try {
      data = JSON.parse(inner);
    } catch {
      continue;
    }
    const found = findProductNode(data);
    if (found) return found;
  }
  return null;
}

function findProductNode(data) {
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    const t = node["@type"];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => String(x).toLowerCase() === "product")) return node;
    stack.push(...Object.values(node));
  }
  return null;
}
