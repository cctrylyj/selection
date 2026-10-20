/**
 * /api/proxy/image?url=<图片地址>
 *
 * 为什么需要它：商品图在山姆 / 亚马逊 / TikTok 的 CDN 上，没有 CORS 头，
 * 浏览器里的 fetch 拿不到字节，Excel 导出就没法把图真正嵌进单元格。
 * 由服务端代为取一次（服务端不受同源策略限制），再同源吐给前端。
 *
 * 安全约束（这个接口等于一个开放代理，必须收紧）：
 *   1. 只允许 http/https，且只允许公网主机 —— 挡住 127.0.0.1 / 内网段，避免被当内网探针；
 *   2. 只允许 Content-Type 是 image/*，避免被拿来抓任意网页/文件；
 *   3. 限制体积与超时，避免被大文件拖死；
 *   4. 不做跟随到内网的二次跳转校验以外的花活，跳到私网直接拒绝。
 */

import { Router } from "express";

import { AppError } from "../lib/errors.js";

const router = Router();

const TIMEOUT_MS = 8000;
const MAX_BYTES = 5 * 1024 * 1024;

/** 私网 / 环回 / 链路本地地址，一律拒绝 */
const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?)$/i;

/**
 * 仅本地 e2e 用：起一个 127.0.0.1 的图片服务验证「下载 → 转码 → 嵌入」整条链路。
 * 默认关闭，生产环境不要打开，否则这个接口就成了内网探针。
 */
const ALLOW_LOCAL = process.env.ALLOW_LOCAL_IMAGE_PROXY === "1";

export function assertPublicUrl(raw) {
  let target;
  try {
    target = new URL(String(raw || ""));
  } catch {
    throw new AppError("BAD_URL", "图片地址不合法", "url 参数必须是完整的 http(s) 地址");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new AppError("BAD_URL", "只支持 http/https 图片地址", "");
  }
  if (!ALLOW_LOCAL && PRIVATE_HOST.test(target.hostname)) {
    throw new AppError("BAD_URL", "不允许访问内网地址", "");
  }
  return target;
}

router.get("/", async (req, res, next) => {
  // 注意：assertPublicUrl 必须放在 try 里面。
  // Express 4 只兜同步抛错，async 处理函数里抛出的会变成未处理的 Promise 拒绝，
  // 在 Node 22 下会直接终止进程——一个畸形 url 就能把整个 API 打挂。
  let timer;
  try {
    const target = assertPublicUrl(req.query.url);

    const ac = new AbortController();
    timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

    const upstream = await fetch(target, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        // 部分 CDN 对没有 UA 的请求直接 403
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "image/avif,image/webp,image/png,image/jpeg,*/*",
      },
    });

    if (!upstream.ok) {
      throw new AppError("IMAGE_FETCH_FAILED", `图片源返回 ${upstream.status}`, "", 502);
    }

    // 跟随跳转后可能落到别的域名，这里再挡一次私网
    const finalUrl = new URL(upstream.url || target.href);
    if (!ALLOW_LOCAL && PRIVATE_HOST.test(finalUrl.hostname)) {
      throw new AppError("BAD_URL", "图片跳转到了内网地址，已拒绝", "");
    }

    const type = (upstream.headers.get("content-type") || "").toLowerCase();
    if (!type.startsWith("image/")) {
      throw new AppError("NOT_IMAGE", "该地址返回的不是图片", `Content-Type: ${type || "未知"}`, 415);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      throw new AppError("IMAGE_TOO_LARGE", "图片超过 5MB，已跳过", "", 413);
    }

    res.set({
      "content-type": type,
      "content-length": String(buf.length),
      // 商品图基本不变，缓存一天，重复导出不必反复回源
      "cache-control": "public, max-age=86400",
    });
    res.send(buf);
  } catch (e) {
    if (e?.name === "AbortError") {
      next(new AppError("IMAGE_TIMEOUT", "图片下载超时", "稍后重试或检查图片地址是否可访问", 504));
      return;
    }
    next(e);
  } finally {
    if (timer) clearTimeout(timer);
  }
});

export default router;
