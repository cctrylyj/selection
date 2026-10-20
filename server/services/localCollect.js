/**
 * 本地采集服务 —— 零凭证替代方案。
 *
 * 场景：用户没有数据服务商账号（Bright Data / Apify）、没有亚马逊联盟或
 * TikTok 开发者资质，也不打算买代理。此时最干净的做法是：
 *
 *   「用户用自己的浏览器打开商品页 → 点书签 → 商品数据写入本系统」
 *
 * 为什么这条路径成立：
 *   1. 请求完全来自用户自己的浏览器，本来就在正常访问页面，不存在代理、
 *      不存在绕过风控，也不存在批量抓取（单页、单次、用户主动触发）；
 *   2. 用户看到的就是价格（含已登录/已验证状态），数据反而比任何
 *      「第三方抓取」更真实；
 *   3. 本服务只做「解析与入库」，不向目标站点发出任何请求（除非用户
 *      选择粘贴 URL，此时仍会先过 robots.txt 检查）。
 *
 * 这里的解析逻辑与 server/crawlers/* 完全同源（同一套 JSON-LD → meta → DOM
 * 三级降级），因此采集来的字段结构与在线检索完全一致，可直接加入选品。
 */

import { cleanText, normalizeProduct, extractJsonLdProduct, pick, toCount } from "../crawlers/base.js";
import { isAllowed } from "../lib/robots.js";
import { ChannelError } from "../lib/errors.js";
// 收件箱存储：本地是进程内数组，部署到 Vercel 时若配了 Redis 就走 Redis
// （Serverless 多实例内存不共享，见 server/lib/inboxStore.js 的说明）
import { inboxPush, inboxList, inboxRemove, inboxReset } from "../lib/inboxStore.js";
// 与浏览器采集脚本（用户脚本 / 书签）共用同一套「拆分价格」识别，
// 见 server/services/collectorDom.js 的说明
import { joinSplitPrice } from "./collectorDom.js";

/**
 * 清空收件箱。
 *
 * 采集数据本身是「还没确认要不要」的临时数据，本地进程重启时清空，
 * 用户重新打开系统看到的是一张空列表，而不是上次会话遗留的、来源不明的商品。
 * 注意：部署到 Vercel 后由 serverless 入口调用，冷启动时机不可控，
 * 所以只有本地长驻服务（server/index.js）才会在启动时清空。
 */
export async function resetInbox() {
  return inboxReset();
}

/** 从收件箱移除指定 id 的采集（用户批量删除时同步调用，避免轮询又拉回来） */
export async function removeFromInbox(ids) {
  return inboxRemove(ids);
}

/**
 * 采集 id。
 *
 * 除了唯一，还必须「按插入顺序能比大小」——因为前端轮询用的是
 * 「since = 上一条 id，只要比它新的」这种游标增量。如果 id 不能比大小，
 * 一旦游标那条被用户删掉（在收件箱里找不到），服务端就只能退化成
 * 「整表返回」，表现就是：删完 4 条，下一秒轮询又把历史那几条拉回来。
 *
 * 所以定宽拼成可直接字符串比较的形式：c_<13位毫秒>_<5位自增>_<随机>
 *   - 13 位毫秒：跨毫秒时天然有序
 *   - 5 位进程内自增：同一毫秒内也能保序，避免随机后缀打乱顺序
 *   - 随机后缀：多实例同时写也不撞 id
 */
let idSeq = 0;
function makeId() {
  const ts = String(Date.now()).padStart(13, "0");
  idSeq = (idSeq + 1) % 100000;
  const seq = String(idSeq).padStart(5, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `c_${ts}_${seq}_${rand}`;
}

/**
 * 写入一批采集记录，返回带 id 的记录。
 * 整批一次写入：批量采集 60 个商品时只走一趟存储。
 */
async function pushToInbox(entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).map((e) => ({
    id: makeId(),
    ...e,
  }));
  await inboxPush(list);
  return list;
}

/**
 * 取从 sinceId 之后的所有未读采集。
 *
 * 用 id 比大小而不是「在列表里找游标的下标」：
 * 游标那条可能已经被用户删掉了（或者被 200 条上限裁掉），
 * 那时下标查找会失败，若退回「全部返回」就会把历史重新灌进表格。
 */
export async function drainInbox(sinceId) {
  const all = await inboxList();
  const cursor = String(sinceId || "").trim();
  if (!cursor) return all;
  return all.filter((x) => String(x.id) > cursor);
}

/* ------------------------------------------------------------------ *
 * 价格 / 文本提取辅助
 * ------------------------------------------------------------------ */

/** 从 "12.34" / "$12.34" / "12,34 €" 里取数值与币种 */
function parsePrice(value, currencyHint) {
  if (value === null || value === undefined) return { price: null, currency: currencyHint || null };
  if (typeof value === "number") {
    return { price: Number.isFinite(value) ? Number(value.toFixed(2)) : null, currency: currencyHint || null };
  }
  const s = String(value).replace(/\s+/g, " ");
  // 注意 ￥ 是全角（U+FFE5），¥ 是半角（U+00A5）：中文站点（亚马逊海外购、
  // 京东等）用的是全角，只匹配半角会把人民币价标成 USD。
  const cur = currencyHint
    || (/[$＄]/.test(s) ? "USD" : null)
    || (/€/.test(s) ? "EUR" : null)
    || (/£/.test(s) ? "GBP" : null)
    || (/[¥￥元]|人民币|RMB|CNY/.test(s) ? "CNY" : null);
  const m = s.match(/-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|-?\d+(?:[.,]\d{1,2})?/);
  if (!m) return { price: null, currency: cur };
  let num = m[0];
  // 欧洲式小数 "12,34" → 12.34；千分位 "1,234.56" 保持
  if (/,\d{1,2}$/.test(num) && !/\.\d{1,2}$/.test(num)) num = num.replace(/\./g, "").replace(",", ".");
  else num = num.replace(/,/g, "");
  const price = Number(num);
  return { price: Number.isFinite(price) ? Number(price.toFixed(2)) : null, currency: cur };
}

/** 备选价：regularPrice / salePrice / listPrice 都过一遍，取第一个能用的 */
function priceFromOffers(offers, currencyHint) {
  const candidates = [];
  const scan = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(scan); return; }
    const p = o.price ?? o.lowPrice ?? o.highPrice;
    if (p !== undefined && p !== null && p !== "") candidates.push(p);
    if (o.priceSpecification) scan(o.priceSpecification);
  };
  scan(offers);
  for (const c of candidates) {
    const r = parsePrice(c, currencyHint);
    if (r.price !== null) return r;
  }
  return { price: parsePrice(pick(offers, ["price", "lowPrice"]), currencyHint).price, currency: currencyHint };
}

/* ------------------------------------------------------------------ *
 * HTML → 商品
 * ------------------------------------------------------------------ */

/** 从 HTML meta 标签取值（property/name/itemprop 三种写法都可能） */
function metaContent(html, keys) {
  for (const k of keys) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${k}["']`, "i"),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) return cleanText(m[1]);
    }
  }
  return "";
}

/**
 * 把一段 HTML 按标签边界拆成文本片段。
 *
 * 关键：标签要换成「分隔」而不是「删除」——山姆把 $16.87 渲染成
 * <span>16</span><span>87</span>，若先把标签删掉再取文本会粘成 "1687"，
 * 拆成片段才能拿到 ["16", "87"]。
 */
function htmlPieces(fragment) {
  return String(fragment || "")
    .split(/<[^>]*>/)
    .map((x) => cleanText(x))
    .filter((x) => x && x.length <= 24);
}

/** DOM 兜底：按优先级试一批通用选择器 */
function domFallback(html) {
  const first = (patterns) => {
    for (const p of patterns) {
      const m = html.match(p);
      if (m && m[1]) return cleanText(m[1]);
    }
    return "";
  };

  const title = first([
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ]);
  const image = first([
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']*)["']/i,
    /<img[^>]+src=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i,
  ]);

  // 价格：先按「拆分结构」识别（大字整数 + 小字角分是两个节点，直接抓文本会粘错），
  // 识别不出来再退回「单个节点就是完整价格」的通用规则。
  const priceBoxTag = html.match(/<[a-z][a-z0-9]*[^>]+(?:class|id)=["'][^"']*price[^"']*["'][^>]*>/i);
  const priceBoxFrag = priceBoxTag ? html.slice(priceBoxTag.index, priceBoxTag.index + 400) : "";
  const splitNum = priceBoxFrag ? joinSplitPrice(htmlPieces(priceBoxFrag)) : "";
  // 容器里单独渲染的货币符号（山姆是上标 $）带上，便于判断币种
  const splitSym = splitNum ? (priceBoxFrag.match(/[$¥€£]/) || [""])[0] : "";
  const priceText = splitNum ? splitSym + splitNum : first([
    /itemprop=["']price["'][^>]*content=["']([^"']*)["']/i,
    /content=["']([^"']*)["'][^>]*itemprop=["']price["']/i,
    /<span[^>]+class=["'][^"']*(?:price|Price)[^"']*["'][^>]*>\s*([^<]{1,40}?)\s*</i,
    /<div[^>]+class=["'][^"']*(?:price|Price)[^"']*["'][^>]*>\s*([^<]{1,40}?)\s*</i,
  ]);

  const category = first([
    /<meta[^>]+itemprop=["']category["'][^>]*content=["']([^"']*)["']/i,
    /"category"\s*:\s*"([^"]{2,120})"/i,
  ]);
  return { title, image, priceText, category };
}

/**
 * 销量 / 评价数：优先 JSON-LD 的 aggregateRating（山姆详情页给的是
 * `"aggregateRating": {"ratingValue": "4.6", "reviewCount": "3821"}`），
 * 再退回页面上的 itemprop / data-* 标注。
 * 注意取 reviewCount / ratingCount，**不要取 ratingValue**——那是星级不是数量。
 */
function extractSales(jsonld, html) {
  const agg = jsonld?.aggregateRating ?? jsonld?.rating ?? null;
  const fromLd = toCount(
    pick(agg, ["reviewCount", "ratingCount", "reviewcount", "ratingcount", "count", "votes"])
  );
  if (fromLd !== null) return fromLd;

  const patterns = [
    /itemprop=["'](?:reviewCount|ratingCount)["'][^>]*content=["']([^"']*)["']/i,
    /content=["']([^"']*)["'][^>]*itemprop=["'](?:reviewCount|ratingCount)["']/i,
    /itemprop=["'](?:reviewCount|ratingCount)["'][^>]*>\s*([^<]{1,20}?)\s*</i,
  ];
  for (const re of patterns) {
    const m = String(html).match(re);
    const n = m ? toCount(m[1]) : null;
    if (n !== null) return n;
  }

  // 页面文案："1,234 ratings" / "6754 条评价" / "1.2K sold"
  const m = String(html).match(
    /(\d[\d,.]*\s*[KkMm万]?)\s*(?:reviews?|ratings?|sold|条评价|评价|销量)/i
  );
  return m ? toCount(m[1].replace(/\s+/g, "")) : null;
}

/** 类目：从面包屑 / JSON-LD category 提取 */
function extractCategory(jsonld, html) {
  const fromLd = jsonld?.category ?? jsonld?.productCategory ?? jsonld?.breadcrumb;
  if (typeof fromLd === "string" && fromLd.trim()) return cleanText(fromLd).slice(0, 500);
  if (Array.isArray(fromLd) && fromLd.length) {
    const names = fromLd.map((x) => (typeof x === "string" ? x : x?.name)).filter(Boolean);
    if (names.length) return cleanText(names.join(" > ")).slice(0, 500);
  }

  const crumbs = [];
  const re = /<(?:nav|ol|ul|div)[^>]+(?:breadcrumb|crumb)[^>]*>([\s\S]*?)<\/(?:nav|ol|ul|div)>/gi;
  let m;
  while ((m = re.exec(html)) && crumbs.length < 12) {
    const items = m[1].match(/<a[^>]*>([\s\S]*?)<\/a>|<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    for (const it of items) {
      const t = cleanText(it.replace(/<[^>]*>/g, " "));
      if (t && t.length < 60 && !crumbs.includes(t)) crumbs.push(t);
    }
  }
  return crumbs.join(" > ").slice(0, 500);
}

/** 主图：JSON-LD image 可能是对象/数组 */
function firstImage(images) {
  const list = Array.isArray(images) ? images : [images];
  for (const im of list) {
    const u = typeof im === "string" ? im : im?.url ?? im?.contentUrl;
    if (u && /^https?:\/\//i.test(u)) return u;
  }
  return "";
}

/**
 * 把一段 HTML 解析成统一商品结构（与在线检索产物同构）。
 * @param {string} html
 * @param {{channel:string, url:string, html?:string}} ctx
 * @returns {object|null}
 */
export function parseProduct(html, ctx) {
  const pageUrl = ctx.url || "";
  const jsonld = extractJsonLdProduct(html);

  // --- 名称 ---
  let productName = cleanText(jsonld?.name ?? "");
  if (!productName) productName = metaContent(html, ["og:title", "twitter:title"]);
  if (!productName) {
    const t = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (t) productName = cleanText(t[1]);
  }
  if (!productName) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) productName = cleanText(t[1]).split(/[|｜-]/)[0].trim();
  }
  if (!productName) return null;

  // --- 渠道内唯一键 ---
  const sku = cleanText(jsonld?.sku ?? jsonld?.mpn ?? jsonld?.productID ?? "");
  const m = pageUrl.match(/\/dp\/([A-Z0-9]{10})|\/ip\/([A-Za-z0-9-]+)|([A-Z0-9._-]{6,})$/i);
  let channelKey = sku || "";
  if (!channelKey && pageUrl) {
    const last = pageUrl.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() || "";
    channelKey = decodeURIComponent(last).slice(0, 64);
  }
  if (!channelKey) channelKey = productName.slice(0, 64);
  // URL 末段常带 index.html / product.aspx 这类后缀，去掉更接近真实 SKU
  channelKey = channelKey.replace(/\.(html?|aspx?|php|jsp)$/i, "").slice(0, 64) || channelKey.slice(0, 64);

  // --- 价格 ---
  const offers = jsonld?.offers ?? jsonld?.offers?.offers ?? null;
  let { price, currency } = priceFromOffers(offers, cleanText(jsonld?.priceCurrency ?? ""));
  if (price === null) {
    const metaAmt = metaContent(html, ["product:price:amount", "og:price:amount", "twitter:data1"]);
    if (metaAmt) ({ price, currency } = parsePrice(metaAmt, currency));
  }
  if (price === null) {
    const dom = domFallback(html);
    if (dom.priceText) ({ price, currency } = parsePrice(dom.priceText, currency));
  }

  // --- 图片 ---
  let imageUrl = firstImage(jsonld?.image);
  if (!imageUrl) imageUrl = metaContent(html, ["og:image", "twitter:image"]);
  if (!imageUrl) imageUrl = domFallback(html).image;

  // --- 类目 ---
  const category = extractCategory(jsonld, html);

  // --- 销量 / 评价数 ---
  const sales = extractSales(jsonld, html);

  // --- 描述（保留在返回里，便于前端展示/用户核对，不入库） ---
  const description = cleanText(jsonld?.description ?? metaContent(html, ["og:description", "description"]))
    .slice(0, 2000);

  return normalizeProduct({
    channel: ctx.channel,
    channelKey,
    productName,
    category,
    price,
    currency: currency || "USD",
    sales,
    imageUrl,
    productUrl: pageUrl,
    description,
    specs: jsonld?.additionalProperty ?? null,
    source: "local",
  });
}

/** 从用户粘贴的裸 JSON-LD 解析（书签可能只回传结构化片段） */
export function parseProductFromJsonLd(jsonLd, ctx) {
  const wrapped = `<script type="application/ld+json">${JSON.stringify(
    typeof jsonLd === "string" ? safeParse(jsonLd) : jsonLd
  )}</script>`;
  return parseProduct(wrapped, ctx);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 粘贴 URL → 后端直连抓取（仍先过 robots.txt）。
 * 注意：这是「用户主动粘贴的单个页面」，不是批量爬取。
 */
export async function collectFromUrl(rawUrl, channel) {
  const url = String(rawUrl || "").trim();
  if (!url) throw new ChannelError("请提供商品链接");
  if (!/^https?:\/\//i.test(url)) {
    throw new ChannelError("链接格式不正确", "请粘贴完整链接，需以 http:// 或 https:// 开头");
  }

  const verdict = await isAllowed(url);
  if (!verdict.allowed) {
    throw new ChannelError(
      "该路径被站点 robots.txt 禁止抓取",
      `命中规则 Disallow: ${verdict.rule}。系统不会向未被允许的页面发请求；`
      + "请改用「浏览器书签采集」——那是你自己的浏览器，不走本服务出口。"
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
  } catch (e) {
    const why = e instanceof Error && e.name === "AbortError" ? "请求超时（20s）" : (e?.message || String(e));
    throw new ChannelError(
      "直接抓取失败",
      `${why}。目标站点可能有反爬限制（山姆、亚马逊、TikTok 都是）；`
      + "推荐改用「浏览器书签采集」，由你自己的浏览器打开页面后一键送回数据。"
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ChannelError(
      `目标站点返回 HTTP ${res.status}`,
      "多数情况是站点反爬（山姆/亚马逊/TikTok 都会拒绝后端直连）。请改用「浏览器书签采集」。"
    );
  }

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("html")) {
    throw new ChannelError("目标链接不是网页", `返回类型 ${ct || "未知"}，请确认是商品详情页。`);
  }

  const html = await res.text();
  if (/are you human|verify you are|captcha|access denied|unusual traffic/i.test(html)) {
    throw new ChannelError(
      "目标站点返回了风控校验页",
      "后端直连被识别为自动化访问。请改用「浏览器书签采集」。"
    );
  }

  const product = parseProduct(html, { channel, url });
  if (!product) {
    throw new ChannelError("页面里没找到结构化商品数据", "请确认链接指向商品详情页；或改用书签采集让浏览器帮你解析。");
  }
  return product;
}

/**
 * 列表页批量采集入口（书签在搜索结果页 / 类目页使用）。
 *
 * 边界说明：这里采集的是「用户自己浏览器里已经加载出来的页面」，字段全部来自
 * DOM 可见内容，系统不向目标站点发出任何请求。用户在自己浏览器里浏览搜索页
 * 不属于自动化抓取；由服务端去请求 `/search` 才是被 robots.txt 禁止的行为。
 *
 * @param {{channel:string, listUrl:string, items:Array<{url,title,price,image,category,sales}>}} payload
 */
export async function collectListFromPayload(payload) {
  const channel = String(payload?.channel || "").trim();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    throw new ChannelError("这一页没有解析到商品", "请等页面商品加载完成后再点书签；或打开单个商品页再采集。");
  }

  const entries = [];
  let skipped = 0;

  // 不做去重：商品本身唯一，页面里出现两条就存两条。
  // skipped 只统计「字段不足/脏数据」，不统计重复。
  for (const item of items) {
    const url = String(item?.url || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) { skipped++; continue; }

    try {
      const product = buildProductFromBookmarkFields({
        channel,
        url,
        title: item?.title,
        price: item?.price,
        image: item?.image,
        category: item?.category,
        sales: item?.sales,
      });
      if (!product) { skipped++; continue; }
      entries.push({ receivedAt: new Date().toISOString(), product, fromList: true });
    } catch {
      skipped++; // 单条脏数据不影响整批
    }
  }

  if (!entries.length) {
    throw new ChannelError(
      "这一页没有解析到商品",
      `共 ${items.length} 个候选，${skipped} 个字段不足被跳过。请确认页面已加载出商品列表。`
    );
  }

  // 整批一次写入，避免 60 个商品走 60 趟存储
  const accepted = await pushToInbox(entries);
  return { count: items.length, inserted: accepted.length, skipped };
}

/**
 * 把书签传来的显式字段构造成统一商品（JSON-LD / HTML 都拿不到时的兜底路径）。
 * 币种从价格文本里推断（"$19.98" → USD，"¥199" → CNY），推断不出才退回 USD。
 */
function buildProductFromBookmarkFields({ channel, url, title, price, image, category, sales }) {
  const name = cleanText(title || "");
  if (!name) return null;

  const { price: num, currency } = parsePrice(price, null);
  const key = String(url || "").replace(/[?#].*$/, "").split("/").filter(Boolean).pop() || "";
  const channelKey = key.replace(/\.(html?|aspx?|php|jsp)$/i, "").slice(0, 64) || name.slice(0, 64);

  return normalizeProduct({
    channel,
    channelKey,
    productName: name,
    category: cleanText(category || ""),
    price: num,
    currency: currency || "USD",
    sales: toCount(sales),
    imageUrl: cleanText(image || ""),
    productUrl: String(url || ""),
    source: "local",
  });
}

/** 书签采集的统一入口：优先 JSON-LD，其次整页 HTML */
export async function collectFromPayload({ channel, url, jsonld, html, title, price, image, category, sales }) {
  const ctx = { channel, url: String(url || "").trim() };
  let product = null;

  if (jsonld) {
    try {
      const payload = typeof jsonld === "string" ? safeParse(jsonld) : jsonld;
      if (payload && typeof payload === "object" && Object.keys(payload).length) {
        product = parseProductFromJsonLd(payload, ctx);
      }
    } catch { /* 落到 html */ }
  }

  if (!product && html) product = parseProduct(html, ctx);

  // 都没有时，至少用书签传过来的显式字段兜底
  if (!product) {
    const name = cleanText(title || "");
    if (!name) {
      throw new ChannelError(
        "没能从页面解析出商品",
        "请确认该页面是商品详情页；如果站点数据是异步加载的，请在页面加载完成后再点书签。"
      );
    }
    const parsed = parsePrice(price, null);
    product = normalizeProduct({
      channel,
      channelKey: url ? (url.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() || name) : name,
      productName: name,
      category: cleanText(category || ""),
      price: parsed.price,
      currency: parsed.currency || "USD",
      sales: toCount(sales),
      imageUrl: cleanText(image || ""),
      productUrl: ctx.url,
      source: "local",
    });
  } else if (product.sales === null && sales !== undefined && sales !== null && sales !== "") {
    // 页面解析没拿到销量、但书签把星级旁的数字传上来了，补进去
    product = { ...product, sales: toCount(sales) };
  }

  const [record] = await pushToInbox([{
    receivedAt: new Date().toISOString(),
    product,
  }]);
  return record;
}
