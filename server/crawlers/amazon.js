/**
 * 渠道：亚马逊（Amazon）—— 官方 Product Advertising API 5.0
 *
 * 合规基线：全部数据来自官方 API，不抓页面、不绕过风控。
 * 文档：https://webservices.amazon.com/paapi5/documentation/
 *
 * 接入条件：
 *   1. Amazon Associates 账号（affiliate-program.amazon.com）
 *   2. 账号需在最近 30 天产生过成交，否则调用会被拒
 *   3. PA-API 有 TPS 限额（初始约 1 request/s，8640/day），超限返回 429
 */

import crypto from "node:crypto";
import { getEnv, requireEnv } from "../lib/env.js";
import { ChannelError } from "../lib/errors.js";
import { cleanText, normalizeProduct, pick } from "./base.js";

const MARKETPLACES = {
  us: { host: "webservices.amazon.com", region: "us-east-1" },
  ca: { host: "webservices.amazon.ca", region: "us-east-1" },
  mx: { host: "webservices.amazon.com.mx", region: "us-east-1" },
  br: { host: "webservices.amazon.com.br", region: "us-east-1" },
  uk: { host: "webservices.amazon.co.uk", region: "eu-west-1" },
  de: { host: "webservices.amazon.de", region: "eu-west-1" },
  fr: { host: "webservices.amazon.fr", region: "eu-west-1" },
  it: { host: "webservices.amazon.it", region: "eu-west-1" },
  es: { host: "webservices.amazon.es", region: "eu-west-1" },
  in: { host: "webservices.amazon.in", region: "eu-west-1" },
  jp: { host: "webservices.amazon.co.jp", region: "us-west-2" },
  au: { host: "webservices.amazon.com.au", region: "us-west-2" },
};

export const channel = {
  id: "amazon",
  label: "亚马逊",
  code: 2,
  supportsKeywordSearch: true,
  docs: "https://webservices.amazon.com/paapi5/documentation/",
};

function marketplaceCfg() {
  const mp = getEnv("AMAZON_MARKETPLACE", "us").toLowerCase();
  const cfg = MARKETPLACES[mp];
  if (!cfg) {
    throw new ChannelError(
      `不支持的 AMAZON_MARKETPLACE：${mp}`,
      `可选值：${Object.keys(MARKETPLACES).join(", ")}`
    );
  }
  return { mp, ...cfg };
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/** AWS Signature V4 —— PA-API 要求的签名方式 */
function buildAuthorization({ accessKey, secretKey, region, service, host, amzDate, amzTarget, payload }) {
  const datestamp = amzDate.slice(0, 8);
  const canonicalUri = amzTarget.startsWith("com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems")
    ? "/paapi5/searchitems"
    : "/paapi5/getitems";

  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${amzTarget}\n`;
  const signedHeaders = "content-encoding;host;x-amz-date;x-amz-target";
  const payloadHash = sha256Hex(payload);

  const canonicalRequest = [
    "POST",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretKey}`, datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return (
    `${algorithm} Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

function isConfigured() {
  return Boolean(
    getEnv("AMAZON_ACCESS_KEY") &&
    getEnv("AMAZON_SECRET_KEY") &&
    getEnv("AMAZON_PARTNER_TAG")
  );
}

async function callPaApi(operation, payload) {
  const accessKey = requireEnv("AMAZON_ACCESS_KEY", "Amazon Associates → 生成 Access Key ID。");
  const secretKey = requireEnv("AMAZON_SECRET_KEY", "Amazon Associates → 生成 Secret Access Key（仅在后端使用）。");
  const partnerTag = requireEnv("AMAZON_PARTNER_TAG", "你的 Associates 追踪 ID，形如 yourname-20。");
  const { host, region, mp } = marketplaceCfg();

  const amzTarget = `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${operation}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const body = JSON.stringify({ ...payload, PartnerTag: partnerTag, PartnerType: "Associates", Marketplace: host.includes(".co.jp") ? "www.amazon.co.jp" : `www.amazon.${mp}` });

  const headers = {
    "Content-Encoding": "amz-1.0",
    "Content-Type": "application/json; charset=utf-8",
    "X-Amz-Date": amzDate,
    "X-Amz-Target": amzTarget,
    Authorization: buildAuthorization({
      accessKey, secretKey, region, service: "ProductAdvertisingAPI", host, amzDate, amzTarget, payload: body,
    }),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(`https://${host}/paapi5/${operation.toLowerCase()}`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (e) {
    const why = e instanceof Error && e.name === "AbortError" ? "请求超时" : (e?.message || String(e));
    throw new ChannelError("PA-API 网络请求失败", why);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ChannelError(`PA-API 返回非 JSON（HTTP ${res.status}）`, text.slice(0, 300));
  }

  if (!res.ok || data.Errors?.length) {
    const err = data.Errors?.[0];
    const code = err?.Code || `HTTP ${res.status}`;
    const message = err?.Message || text.slice(0, 300);
    let hint = "";
    if (res.status === 429) {
      hint = "触发 TPS 限额。PA-API 初始约 1 QPS / 8640 每天，请降低频率或申请提额。";
    } else if (res.status === 503) {
      hint = "PA-API 服务繁忙，稍后重试。";
    } else if (code.includes("InvalidParameterValue") || code.includes("Not a valid value")) {
      hint = "参数错误，通常是 PartnerTag 未通过校验或 Associates 账号未满足 30 天成交要求。";
    } else if (res.status === 403) {
      hint = "无权限。常见原因：Access Key 未关联到已审核 Associates 账号，或账号近期无成交。";
    }
    throw new ChannelError(`PA-API ${code}: ${message}`, hint);
  }

  return data;
}

function mapItem(raw) {
  const info = raw.ItemInfo ?? {};
  const listing = raw.Offers?.Listings?.[0];
  const price = listing?.Price;
  const classes = info.Classifications;
  const binding = classes?.Binding?.DisplayValue || classes?.ProductGroup?.DisplayValue || "";

  return normalizeProduct({
    channel: channel.id,
    channelKey: raw.ASIN ?? raw.DetailPageURL ?? "",
    productName: cleanText(info.Title?.DisplayValue),
    category: cleanText(binding || info.ProductInfo?.UnitCount?.DisplayValue || ""),
    price: price?.Amount ?? null,
    currency: price?.Currency ?? getEnv("AMAZON_CURRENCY_DEFAULT", "USD"),
    imageUrl: cleanText(raw.Images?.Primary?.Medium?.URL || ""),
    productUrl: cleanText(raw.DetailPageURL || ""),
  });
}

export async function search(keyword, { itemCount = 20 } = {}) {
  const kw = String(keyword ?? "").trim();
  if (!kw) throw new ChannelError("请输入商品名称关键词", "亚马逊渠道支持关键词检索。");

  if (!isConfigured()) {
    throw new ChannelError(
      "亚马逊渠道未配置 PA-API 凭证",
      "在 .env 中填入 AMAZON_ACCESS_KEY / AMAZON_SECRET_KEY / AMAZON_PARTNER_TAG。",
      "NOT_CONFIGURED"
    );
  }

  const data = await callPaApi("SearchItems", {
    Keywords: kw,
    SearchIndex: "All",
    ItemCount: Math.min(Math.max(itemCount, 1), 10),
    Resources: [
      "Images.Primary.Medium",
      "ItemInfo.Title",
      "ItemInfo.Classifications",
      "ItemInfo.ByLineInfo",
      "Offers.Listings.Price",
    ],
  });

  const items = data.SearchResult?.Items ?? [];
  const out = [];
  const failed = [];
  for (const it of items) {
    try {
      out.push(mapItem(it));
    } catch (e) {
      failed.push(pick(e, ["message"]));
    }
  }
  if (!out.length && items.length) {
    throw new ChannelError("PA-API 返回了商品但字段解析为空", `原始返回片段：${JSON.stringify(items[0]).slice(0, 400)}`);
  }
  return { items: out, failed, total: items.length };
}

/** 按 ASIN 精确查询 */
export async function getItems(asins) {
  const list = String(asins).split(/[\s,]+/).filter(Boolean).slice(0, 10);
  if (!list.length) throw new ChannelError("请输入 ASIN");
  const data = await callPaApi("GetItems", {
    ItemIds: list,
    Resources: ["Images.Primary.Medium", "ItemInfo.Title", "ItemInfo.Classifications", "Offers.Listings.Price"],
  });
  return (data.ItemsResult?.Items ?? []).map(mapItem);
}
