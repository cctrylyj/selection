/**
 * 渠道：山姆会员店（Sam's Club）
 *
 * 现实约束（决定实现方式的原因）：
 *   1. 山姆没有公开的商品 API，只有 Walmart 面向卖家/供应商的接口。
 *   2. samsclub.com/robots.txt 中 `Disallow: /search` —— 站内搜索页禁止抓取；
 *      类目页 `/c/...` 与商品详情页 `/ip/...` 都未被 Disallow，允许抓。
 *   3. 站点有 Akamai 风控，必须经由 Bright Data Web Unlocker 取内容，本进程不跑浏览器。
 *
 * 因此本渠道提供三种模式（用途是「选品参考」，不是精确补数）：
 *   a) 产品类型浏览（主路径，推荐）：
 *      用户输入产品类型关键词 → 从 sitemap.xml 里解析出全站 /c/ 类目页清单 →
 *      按关键词匹配类目 → 抓类目页拿到 /ip/ 商品链接 → 逐个抓详情页取 JSON-LD。
 *      全程只碰 robots 允许的 /sitemap.xml、/c/、/ip/。
 *   b) 精确查询：用户粘贴商品链接或 Item ID，经 robots 校验后抓 /ip/ 详情页。
 *   c) 关键词走数据集：配置了 SAMS_DATASET_ID 时优先用它（更快，配额更省）。
 */

import { getEnv } from "../lib/env.js";
import { ConfigError, ChannelError } from "../lib/errors.js";
import { assertAllowed } from "../lib/robots.js";
import { TtlCache } from "../lib/cache.js";
import { cleanText, extractJsonLdProduct, normalizeProduct } from "./base.js";
import { isWebUnlockerConfigured, webUnlockerHtml } from "./providers/brightdataWebUnlocker.js";
import { isDatasetConfigured, triggerDataset } from "./providers/brightdataDataset.js";

export const channel = {
  id: "samsclub",
  label: "山姆会员店",
  code: 1,
  supportsKeywordSearch: true,
  docs: "https://www.samsclub.com/robots.txt",
};

const SITEMAP_INDEX = "https://www.samsclub.com/sitemap.xml";
const sitemapCache = new TtlCache(24 * 60 * 60 * 1000);
const categoryProductsCache = new TtlCache(60 * 60 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function configErrors() {
  if (!isWebUnlockerConfigured()) {
    throw new ConfigError(
      "山姆渠道需要配置 Bright Data Web Unlocker（无官方 API）",
      "在 .env 填入 BRIGHTDATA_API_TOKEN 与 BRIGHTDATA_ZONE。"
    );
  }
}

/** 把用户输入的山姆链接 / Item ID 归一成商品详情页 URL */
export function toProductUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  let url;
  if (/^https?:\/\//i.test(raw)) {
    url = raw;
  } else if (/^\d{6,}$/.test(raw)) {
    url = `https://www.samsclub.com/ip/${raw}`;
  } else {
    return null;
  }

  try {
    const u = new URL(url.replace(/^https?:/i, "https:"));
    if (!/(^|\.)samsclub\.com$/.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function extractCategory(html) {
  // 优先面包屑
  const navMatch = html.match(
    /<nav[^>]*(?:aria-label|data-testid)=["'][^"']*(?:breadcrumb|readcrumb)[^"']*["'][^>]*>([\s\S]{0,4000}?)<\/nav>/i
  );
  const scope = navMatch ? navMatch[1] : html;
  const anchors = [...scope.matchAll(/<a[^>]+href="\/c\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => cleanText(m[1]))
    .filter(Boolean);
  if (anchors.length) return anchors.join(" > ");
  return "";
}

function specsToText(specs) {
  if (!specs) return "";
  const pairs = [];
  const list = Array.isArray(specs) ? specs : [specs];
  for (const item of list) {
    if (!item) continue;
    const name = item.name ?? item.key ?? item.label;
    const value = item.value ?? item.val;
    if (name && value !== undefined && value !== null && value !== "") {
      pairs.push(`${cleanText(name)}: ${cleanText(value)}`);
    }
  }
  return pairs.join(" ; ").slice(0, 1000);
}

/**
 * 精确查询：一个链接 / Item ID → 0..1 条商品
 */
export async function fetchProductByUrl(input) {
  const url = toProductUrl(input);
  if (!url) {
    throw new ChannelError(
      "无法识别为山姆商品链接或 Item ID",
      "支持形如 https://www.samsclub.com/ip/xxx/1425143980 或纯 Item ID（1425143980）。"
    );
  }

  await assertAllowed(url);

  if (!isWebUnlockerConfigured()) {
    throw new ConfigError(
      "山姆渠道需要配置 Bright Data Web Unlocker（无官方 API）",
      "在 .env 填入 BRIGHTDATA_API_TOKEN 与 BRIGHTDATA_ZONE。"
    );
  }

  const html = await webUnlockerHtml(url);
  const ld = extractJsonLdProduct(html);
  if (!ld) {
    throw new ChannelError(
      "详情页中未找到 schema.org/Product 结构化数据",
      "可能是站点改版或抓到了风控页。可用 --fetch-only 思路保存 HTML 人工核对。"
    );
  }

  const offers = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
  const image = Array.isArray(ld.image) ? ld.image[0] : ld.image;
  const priceRaw = offers?.price ?? offers?.lowPrice ?? offers?.priceSpecification?.price;
  const channelKey = ld.sku ?? ld.productID ?? ld.mpn ?? new URL(url).pathname.split("/").pop() ?? "";
  // 销量 / 评价数：山姆详情页的 JSON-LD 里有
  // "aggregateRating": {"ratingValue":"4.6","reviewCount":"3821"}
  // 取 reviewCount / ratingCount，**不要取 ratingValue**（那是星级不是数量）
  const agg = ld.aggregateRating ?? ld.rating ?? null;
  const sales = agg ? (agg.reviewCount ?? agg.ratingCount ?? agg.count ?? null) : null;

  return normalizeProduct({
    channel: channel.id,
    channelKey,
    productName: cleanText(ld.name),
    category: extractCategory(html),
    price: priceRaw,
    currency: offers?.priceCurrency ?? "USD",
    sales,
    imageUrl: cleanText(image),
    productUrl: url,
    _specs: specsToText(ld.additionalProperty ?? ld.specifications),
  });
}

/** 递归替换对象里的字符串占位符 */
function replaceInObject(value, token, replacement) {
  if (typeof value === "string") return value.split(token).join(replacement);
  if (Array.isArray(value)) return value.map((v) => replaceInObject(v, token, replacement));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceInObject(v, token, replacement);
    return out;
  }
  return value;
}

/** 从 XML 里取所有 <loc> 内容 */
export function parseLocs(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

export function isCategoryUrl(url) {
  return /samsclub\.com\/c\/[^?#]+/i.test(url);
}

/** 纯函数：按关键词给类目页打分排序（可离线测试） */
export function rankCategories(urls, keyword, maxResults) {
  const tokens = String(keyword)
    .toLowerCase()
    .split(/[\s,，、/]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 2);

  if (!tokens.length) return [];

  const joined = tokens.join("-");
  return urls
    .map((url) => {
      const hay = url.toLowerCase();
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score += t.length + 2;
      if (joined.length > 3 && hay.includes(joined)) score += joined.length + 10;
      return { url, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((x) => x.url);
}

/**
 * 从 sitemap 索引里挖出全站 /c/ 类目页清单。
 * sitemap.xml 明确写在 robots.txt 的 Sitemap: 行里，是站点主动公开的抓取入口。
 */
async function getCategoryUrls() {
  const cached = sitemapCache.get("sams:category-urls");
  if (cached) return cached;

  configErrors();
  await assertAllowed(SITEMAP_INDEX);

  const categories = [];
  const seen = new Set();

  const walk = async (url, depth) => {
    if (depth > 2 || categories.length > 5000) return;
    let xml;
    try {
      xml = await webUnlockerHtml(url, { timeoutMs: 60000 });
    } catch (e) {
      // 单个 sitemap 挂了不影响其它的
      if (depth === 0) throw e;
      return;
    }

    const locs = parseLocs(xml);
    const childSitemaps = locs.filter((l) => l.toLowerCase().endsWith(".xml"));

    if (childSitemaps.length) {
      // 优先只走跟类目相关的子 sitemap，避免把全站都拉一遍
      const preferred = childSitemaps.filter((l) => /(categor|browse|taxonom|\/c\/)/i.test(l));
      const walkList = preferred.length ? preferred : childSitemaps;
      for (const child of walkList.slice(0, 40)) {
        await walk(child, depth + 1);
      }
    }

    for (const loc of locs) {
      if (isCategoryUrl(loc) && !seen.has(loc)) {
        seen.add(loc);
        categories.push(loc);
      }
    }
  };

  await walk(SITEMAP_INDEX, 0);
  sitemapCache.set("sams:category-urls", categories);
  return categories;
}

/** 关键词 → 打分最高的类目页 */
async function resolveCategories(keyword, maxResults) {
  const all = await getCategoryUrls();
  if (!all.length) {
    throw new ChannelError(
      "未能从 sitemap 解析出山姆类目页",
      "请确认 BRIGHTDATA_API_TOKEN 可用；或在 .env 配置 SAMS_DATASET_ID 改走数据集。",
      "CAPABILITY_LIMITED"
    );
  }
  return rankCategories(all, keyword, maxResults);
}

/** 类目页 → /ip/ 商品链接（不去重，页面里出现几次就取几次） */
export function extractProductUrls(html, limit) {
  const urls = [];
  const re = /<a[^>]+href=["']([^"']*\/ip\/[^"'?#]+)["']/gi;
  for (const m of html.matchAll(re)) {
    let href = m[1].trim();
    if (href.startsWith("/")) href = `https://www.samsclub.com${href}`;
    if (!href.startsWith("http")) continue;
    const clean = href.replace(/^http:\/\//i, "https://");
    urls.push(clean);
    if (urls.length >= limit) break;
  }
  return urls;
}

/**
 * 产品类型浏览：关键词 → 类目页 → 商品详情页。
 * 只访问 /sitemap.xml、/c/、/ip/，三者都不在 robots Disallow 列表里。
 */
export async function browseByCategory(keyword) {
  const productLimit = Math.min(30, Math.max(1, Number(getEnv("SAMS_PRODUCT_LIMIT", "12"))));
  const categoryLimit = Math.min(5, Math.max(1, Number(getEnv("SAMS_CATEGORY_LIMIT", "3"))));

  configErrors();

  const categoryUrls = await resolveCategories(keyword, categoryLimit);
  if (!categoryUrls.length) {
    throw new ChannelError(
      `没有在山姆类目里找到与「${keyword}」匹配的产品类型`,
      "可以换个说法，例如用英文品名（bath tissue）或更通用的词（coffee）。"
      + "若你已配 SAMS_DATASET_ID，会优先生效。"
    );
  }

  const durationMs = Number(getEnv("SAMS_PRODUCT_FETCH_DELAY", "800"));
  const products = [];
  const failed = [];
  const productHashMap = new Map();

  for (const categoryUrl of categoryUrls) {
    await assertAllowed(categoryUrl);

    let listing;
    const cacheKey = `sams:cat:${categoryUrl}`;
    const cachedListing = categoryProductsCache.get(cacheKey);
    if (cachedListing) {
      listing = cachedListing;
    } else {
      const html = await webUnlockerHtml(categoryUrl, { timeoutMs: 60000 });
      listing = extractProductUrls(html, productLimit);
      categoryProductsCache.set(cacheKey, listing);
    }

    for (const productUrl of listing) {
      if (productHashMap.has(productUrl)) continue;
      productHashMap.set(productUrl, true);
      if (products.length >= productLimit) break;
      try {
        products.push(await fetchProductByUrl(productUrl));
      } catch (e) {
        failed.push(cleanText(e?.message || "抓取失败"));
      }
      await sleep(durationMs);
    }
    if (products.length >= productLimit) break;
  }

  if (!products.length) {
    throw new ChannelError(
      "类目页解析成功但没有拿到任何商品",
      "类目页可能是客户端渲染取不到链接，或详情页解析规则与站点改版前不一致。"
      + "可在 .env 配置 SAMS_DATASET_ID 改走数据集。"
    );
  }
  return products;
}

/** 关键词搜索：优先数据集，其次类目浏览 */
export async function searchByKeyword(keyword) {
  if (isDatasetConfigured()) {
    const datasetId = getEnv("SAMS_DATASET_ID");
    let input;
    try {
      input = replaceInObject(
        [{ ...JSON.parse(getEnv("SAMS_DATASET_INPUT_TEMPLATE", '{"search_term":"{q}"}')) }],
        "{q}",
        keyword
      );
    } catch (e) {
      throw new ChannelError(
        "SAMS_DATASET_INPUT_TEMPLATE 不是合法 JSON",
        `错误：${e instanceof Error ? e.message : String(e)}`
      );
    }
    const rows = await triggerDataset(datasetId, input);
    const items = [];
    for (const row of rows) {
      try {
        items.push(
          normalizeProduct({
            channel: channel.id,
            channelKey: row.sku ?? row.item_id ?? row.product_id ?? row.url ?? "",
            productName: cleanText(row.product_name ?? row.title ?? row.name),
            category: cleanText(row.category ?? row.breadcrumb ?? ""),
            price: row.final_price ?? row.price ?? row.current_price,
            currency: row.currency ?? "USD",
            imageUrl: cleanText(row.image_url ?? row.image ?? ""),
            productUrl: cleanText(row.product_url ?? row.url ?? ""),
          })
        );
      } catch {
        // 单行脏数据跳过，不影响整批
      }
    }
    return items;
  }
  return browseByCategory(keyword);
}

/**
 * 适配器入口。keyword 以产品类型关键词为主；
 * 若粘贴的是商品链接 / Item ID，则走精确查询。
 */
export async function search(keyword) {
  const input = String(keyword ?? "").trim();
  if (!input) {
    throw new ChannelError("请输入产品类型关键词", "例如 bath tissue、coffee、宠物食品");
  }

  if (toProductUrl(input)) {
    const item = await fetchProductByUrl(input);
    return [item];
  }
  return searchByKeyword(input);
}
