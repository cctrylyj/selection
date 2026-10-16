/**
 * 渠道：TikTok Shop —— 官方开放平台 Open API
 * 文档：https://partner.tiktokshop.com/docv2
 *
 * 能力边界（必须先说清楚，否则会白折腾）：
 *   1. 需要「已审批的开发者应用」+ 卖家授权（OAuth2），不是注册就能用的；
 *   2. 商品检索接口 /product/202309/products/search 主要面向「管理自己店铺的商品」，
 *      不是平台全量商品的货源检索。做选品更实际的用法是浏览类目接口，
 *      但同样需要类目权限 + 分页拉取，配额很紧；
 *   3. 区域区分：美区 api.tiktokshop.com、东南亚 api.tiktokglobalshop.com、欧盟 api.tiktokshop.eu；
 *   4. access_token 有有效期，需要 refresh_token 轮换。
 *
 * 签名规则按官方文档实现：HMAC-SHA256(app_secret, path + 参数拼接 + body)，
 * 参数按 key 升序、去掉 sign/access_token。
 * 若上游返回签名错误，请以官方文档当前版本为准核对。
 */

import crypto from "node:crypto";
import { getEnv, requireEnv } from "../lib/env.js";
import { ChannelError } from "../lib/errors.js";
import { cleanText, normalizeProduct } from "./base.js";

export const channel = {
  id: "tiktokshop",
  label: "TikTok Shop",
  code: 3,
  supportsKeywordSearch: true,
  docs: "https://partner.tiktokshop.com/docv2",
};

const PATH = "/product/202309/products/search";

function base() {
  const raw = getEnv("TIKTOK_API_BASE", "https://open-api.tiktokglobalshop.com");
  return raw.replace(/\/+$/, "");
}

function isConfigured() {
  return Boolean(
    getEnv("TIKTOK_APP_KEY") &&
    getEnv("TIKTOK_APP_SECRET") &&
    getEnv("TIKTOK_ACCESS_TOKEN")
  );
}

/** 官方文档的签名算法 */
function generateSign(path, params, body, appSecret) {
  const baseStr = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "access_token")
    .sort()
    .map((k) => params[k] === undefined || params[k] === null || params[k] === "" ? k : `${k}${params[k]}`)
    .join("");

  const signStr = `${path}${baseStr}${body ? JSON.stringify(body) : ""}`;
  return crypto.createHmac("sha256", appSecret).update(signStr).digest("hex");
}

function buildParams() {
  return {
    app_key: requireEnv("TIKTOK_APP_KEY", "TikTok Shop 开发者后台 → 应用 → App Key。"),
    timestamp: String(Math.floor(Date.now() / 1000)),
    sign_method: "hmac_sha256",
  };
}

async function request(body) {
  const appKey = getEnv("TIKTOK_APP_KEY");
  const appSecret = requireEnv("TIKTOK_APP_SECRET", "TikTok Shop 开发者后台 → 应用 → App Secret（仅后端使用）。");
  const accessToken = requireEnv("TIKTOK_ACCESS_TOKEN", "卖家授权后获取的 access token，有有效期需定期刷新。");

  const params = buildParams();
  params.app_key = appKey || params.app_key;
  const sign = generateSign(PATH, params, body, appSecret);
  const query = new URLSearchParams({ ...params, sign });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(`${base()}${PATH}?${query.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tts-access-token": accessToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const why = e instanceof Error && e.name === "AbortError" ? "请求超时" : (e?.message || String(e));
    throw new ChannelError("TikTok Shop 接口请求失败", why);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ChannelError(`TikTok Shop 返回非 JSON（HTTP ${res.status}）`, text.slice(0, 300));
  }

  if (data.code !== 0) {
    const msg = data.message || `HTTP ${res.status}`;
    let hint = "";
    if (/sign/i.test(String(data.code)) || /signature/i.test(msg)) {
      hint = "签名校验失败。请以官方文档当前版本核对签名算法、app_secret 与时间戳。";
    } else if (/token|auth/i.test(msg)) {
      hint = "授权失败。access_token 可能过期，需要走 refresh 流程重新获取。";
    } else if (/permission|scope/i.test(msg)) {
      hint = "缺少类目/接口权限，需要在开发者后台为该应用申请对应 scope 并重新授权。";
    }
    throw new ChannelError(`TikTok Shop ${data.code}: ${msg}`, hint);
  }
  return data;
}

function mapProduct(p) {
  const skus = p.skus ?? [];
  const first = skus[0] ?? {};
  const price = first.price?.sale_price ?? first.price?.original_price;
  const images = p.images ?? p.main_images ?? [];
  const categories = p.category_chains ?? [];
  const category = Array.isArray(categories)
    ? categories.flat(Infinity).filter(Boolean).join(" > ")
    : "";

  return normalizeProduct({
    channel: channel.id,
    channelKey: p.id ?? p.product_id ?? "",
    productName: cleanText(p.title ?? p.name),
    category: cleanText(category),
    price: price ? Number(price) : null,
    currency: "USD",
    // 销量：TikTok Shop 开放平台在不同版本里叫 sold_count / sales_count / sales，
    // 取到哪个用哪个；都没有就是 null（前端显示「—」），不要用 0 冒充。
    sales: p.sold_count ?? p.sales_count ?? p.sales ?? p.sold ?? null,
    imageUrl: cleanText(images[0]?.url ?? (typeof images[0] === "string" ? images[0] : "")),
    productUrl: p.share_url ?? p.url ?? "",
  });
}

export async function search(keyword, { pageSize = 20, pageNumber = 1 } = {}) {
  if (!isConfigured()) {
    throw new ChannelError(
      "TikTok Shop 渠道未配置凭证",
      "需在开发者平台 https://partner.tiktokshop.com/ 创建已审批应用，完成卖家授权后，"
      + "把 TIKTOK_APP_KEY / TIKTOK_APP_SECRET / TIKTOK_ACCESS_TOKEN 填入 .env。",
      "NOT_CONFIGURED"
    );
  }

  const data = await request({
    page_size: Math.min(Math.max(pageSize, 1), 100),
    page_number: pageNumber,
    search_status: true,
    ...(keyword && String(keyword).trim()
      ? { keyword: String(keyword).trim() }
      : {}),
  });

  const list = data.data?.products ?? data.data?.product_list ?? [];
  const items = [];
  const failed = [];
  for (const p of list) {
    try {
      items.push(mapProduct(p));
    } catch (e) {
      failed.push(cleanText(e?.message));
    }
  }
  return { items, failed, total: data.data?.total_count ?? list.length };
}
