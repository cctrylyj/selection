/** /api/products —— 渠道列表 + 商品检索（走服务端爬虫适配器） */

import { Router } from "express";
import { listChannels, searchChannel } from "../crawlers/index.js";
import { CHANNEL_IDS } from "../crawlers/base.js";
import { ChannelError } from "../lib/errors.js";
import { createLimiter } from "../lib/rateLimit.js";
import { TtlCache } from "../lib/cache.js";
import {
  collectFromUrl,
  collectFromPayload,
  collectListFromPayload,
  drainInbox,
  removeFromInbox,
  resetInbox,
  parseProduct,
  parseProductFromJsonLd,
} from "../services/localCollect.js";
import { buildBookmarklet } from "../services/bookmarklet.js";
import { PRICE_HELPER_SRC } from "../services/collectorDom.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const router = Router();

const searchLimiter = createLimiter(20, 5 * 60 * 1000); // 5 分钟 20 次，保护外部接口配额
const cache = new TtlCache(10 * 60 * 1000);

/** 书签采集由用户浏览器直接 POST 过来，必须跨域；仅放开这几个接口 */
function withCors(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  // Chrome 的私有网络访问（PNA）检查：从公网站点（samsclub.com）请求本机
  // 127.0.0.1 会先发带 Access-Control-Request-Private-Network 的预检，
  // 不回应这个头就会直接被拦掉，表现为「按钮点了没反应 / 网络错误」。
  res.header("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}

function assertChannel(channel) {
  if (!CHANNEL_IDS.includes(channel)) {
    throw new ChannelError(
      `未知渠道：${channel || "(空)"}`,
      `可选：${CHANNEL_IDS.join(" / ")}`
    );
  }
}

/**
 * 本服务对外的完整地址（不带尾斜杠）。
 *
 * 用途：生成采集脚本里的 BASE、书签代码里的接口地址。
 * 为什么不能只靠 req.protocol：脚本是在 samsclub.com（https）里执行的，
 * 拿到 http:// 地址会被浏览器的混合内容策略直接拦掉，表现为「点了没反应」。
 * 部署到 Vercel 时 app 里开了 trust proxy，req.protocol 会读 x-forwarded-proto
 * 得到 https；配了自定义域名时用 PUBLIC_BASE_URL 显式指定最稳。
 */
function publicOrigin(req) {
  const fixed = (process.env.PUBLIC_BASE_URL || "").trim();
  if (fixed) return fixed.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

router.get("/channels", (_req, res) => {
  res.json({ ok: true, data: listChannels() });
});

// ---------------------------------------------------------------------------
// 零凭证采集通道（不需要数据服务商、不需要联盟/开发者账号）
// ---------------------------------------------------------------------------

/** 书签采集入口：由 bookmarklet 在商品页调用 */
router.post("/collect", withCors, async (req, res, next) => {
  try {
    const channel = String(req.body?.channel || "").trim();
    assertChannel(channel);
    const record = await collectFromPayload({
      channel,
      url: req.body?.url,
      jsonld: req.body?.jsonld,
      html: req.body?.html,
      title: req.body?.title,
      price: req.body?.price,
      image: req.body?.image,
      category: req.body?.category,
      sales: req.body?.sales,
    });
    res.json({ ok: true, data: record });
  } catch (e) {
    next(e);
  }
});

/**
 * 下载 Tampermonkey 采集脚本。
 * 比 javascript: 书签可靠：不受目标站 CSP 拦截、不用往书签栏粘贴。
 */
router.get("/collector-script", withCors, async (req, res, next) => {
  try {
    const channel = String(req.query.channel || "samsclub").trim();
    const ch = CHANNEL_IDS.includes(channel) ? channel : "samsclub";
    const origin = publicOrigin(req);
    const base = `${origin}/api/products/collect`;
    const update = `${origin}/api/products/collector-script?channel=${ch}`;
    const tplPath = fileURLToPath(new URL("../services/userscript.template.js", import.meta.url));
    const tpl = await readFile(tplPath, "utf-8");
    const script = tpl
      .replace("__BASE__", base)
      .replace("__CHANNEL__", ch)
      .replace(/__UPDATE__/g, update)
      // 注入共用的价格解析代码（与书签通道同一份实现）。
      // 这里必须用替换函数而不是字符串：源码里有 "$" 字符，作为字符串替换时
      // $& / $' / $` 会被当成特殊序列展开，把代码改坏。
      .replace("/* __PRICE_HELPER__ */", () => PRICE_HELPER_SRC);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="sourcing-collector.user.js"');
    res.send(script);
  } catch (e) {
    next(e);
  }
});

/** 列表页批量采集（书签在搜索结果页 / 类目页使用） */
router.post("/collect-list", withCors, async (req, res, next) => {
  try {
    const channel = String(req.body?.channel || "").trim();
    assertChannel(channel);
    const result = await collectListFromPayload({
      channel,
      listUrl: req.body?.listUrl,
      items: req.body?.items,
    });
    res.json({ ok: true, data: result });
  } catch (e) {
    next(e);
  }
});

/**
 * 删除采集记录：批量（ids）或清空（all）。
 * 之所以要同步删服务端：轮询用 since 游标只推增量，若只删前端，
 * 用户刷新页面后历史会被重新拉回来，删除等于无效。
 */
router.delete("/collect/inbox", async (req, res, next) => {
  try {
    const all = req.body?.all === true;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
    if (!all && !ids.length) {
      throw new ChannelError("请提供要删除的 ids，或 all=true 清空全部");
    }
    const removed = all ? await resetInbox() : await removeFromInbox(ids);
    res.json({ ok: true, data: { removed } });
  } catch (e) {
    next(e);
  }
});

/** 前端轮询：拉取自 sinceId 之后的新采集 */
router.get("/collect/pending", async (req, res, next) => {
  try {
    const since = String(req.query.since || "").trim();
    res.json({ ok: true, data: { items: await drainInbox(since) } });
  } catch (e) {
    next(e);
  }
});

/** 生成书签安装信息（bookmarklet + 采集地址） */
router.get("/collect-info", (req, res) => {
  const channel = String(req.query.channel || "samsclub").trim();
  const ch = CHANNEL_IDS.includes(channel) ? channel : "samsclub";
  const base = `${publicOrigin(req)}/api/products/collect`;
  res.json({
    ok: true,
    data: {
      collectUrl: base,
      defaultChannel: ch,
      bookmarklet: buildBookmarklet(base, ch),
    },
  });
});

/** 粘贴导入：URL / 整页 HTML / JSON-LD 三种都支持 */
router.post("/import", async (req, res, next) => {
  try {
    const channel = String(req.body?.channel || "").trim();
    assertChannel(channel);
    const { url, html, jsonld } = req.body ?? {};

    let product;
    if (url) {
      product = await collectFromUrl(url, channel);
    } else if (html) {
      product = parseProduct(String(html), { channel, url: "" });
    } else if (jsonld) {
      product = parseProductFromJsonLd(jsonld, { channel, url: "" });
    } else {
      throw new ChannelError("请提供商品链接、页面 HTML 或 JSON-LD 片段", "三种任选其一即可。");
    }

    if (!product) {
      throw new ChannelError(
        "没能解析出商品信息",
        "请确认内容来自商品详情页；站点改版会导致选择器失效，可换用书签采集。"
      );
    }

    const record = { id: `i_${Date.now().toString(36)}`, receivedAt: new Date().toISOString(), product };
    res.json({ ok: true, data: record });
  } catch (e) {
    next(e);
  }
});

router.get("/search", async (req, res, next) => {
  try {
    const ip = req.ip || "unknown";
    const lim = searchLimiter(ip);
    if (!lim.ok) {
      throw new ChannelError(
        "请求过于频繁",
        `搜索接口限流：5 分钟内最多 20 次，请 ${lim.retryAfterSec}s 后重试。`,
        "RATE_LIMITED"
      );
    }

    const channel = String(req.query.channel || "").trim();
    const keyword = String(req.query.keyword || "").trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));

    if (!channel) throw new ChannelError("缺少 channel 参数", "可选：samsclub / amazon / tiktokshop");
    if (!keyword) {
      throw new ChannelError(
        "请输入产品类型关键词",
        "例如 bath tissue、coffee、婴儿纸尿裤；山姆渠道也支持直接粘贴商品链接或 Item ID。"
      );
    }

    const cacheKey = `${channel}|${keyword.toLowerCase()}|${page}|${pageSize}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      res.json({ ok: true, data: { ...hit, cached: true } });
      return;
    }

    const result = await searchChannel(channel, keyword, { page, pageSize });
    const payload = {
      channel,
      keyword,
      items: result.items,
      failed: result.failed,
      total: result.total,
      cached: false,
    };
    cache.set(cacheKey, payload);
    res.json({ ok: true, data: payload });
  } catch (e) {
    next(e);
  }
});

export default router;
