/** 极简固定窗口限流。爬虫接口单价高，不能被人当免费接口刷。 */

const buckets = new Map();

/**
 * @param {string} key   通常是 IP
 * @param {number} limit 窗口内允许次数
 * @param {number} windowMs
 * @returns {{ok: boolean, retryAfterSec: number}}
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) {
    return { ok: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfterSec: 0 };
}

export function createLimiter(limit, windowMs) {
  return (key) => rateLimit(key, limit, windowMs);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}, 60_000).unref();
