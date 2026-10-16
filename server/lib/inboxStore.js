/**
 * 采集收件箱的存储层。
 *
 * 为什么需要这一层：
 *   收件箱原来是「进程内数组」。本地单进程跑没问题，但 Vercel 是 Serverless：
 *   一次采集（POST /api/products/collect-list）和随后的轮询
 *   （GET /api/products/collect/pending）很可能落到不同的函数实例上，
 *   内存不共享，表现就是「采集成功提示出来了，但表格里一直不出现」。
 *
 *   所以把存储抽象出来：
 *     - 配了 Redis（Vercel KV / Upstash）→ 走 Redis，多实例共享，稳定；
 *     - 没配 → 退回进程内内存（本地开发、单实例部署照常用，行为与以前完全一致）。
 *
 * Redis 走 Upstash 的 REST 协议（Vercel KV 底层就是 Upstash），不引任何 SDK：
 * 少一个依赖、冷启动更轻，也不需要额外的连接管理。
 *
 * 数据结构：一个 LIST，老的在前新的在后，与原来内存数组的顺序一致。
 */

const KEY = "sourcing:inbox";
const MAX = 200; // 最多保留最近 200 条，与原来的 INBOX_LIMIT 一致
const TTL_SECONDS = 60 * 60 * 24; // 1 天没动静自动过期，避免脏数据长期占着

/** 进程内兜底存储 */
const mem = [];

/** 读取 Redis 连接信息：Vercel KV 与 Upstash 两套变量名都认 */
function redisConfig() {
  const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
  const token = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

/** 当前用的是哪种后端，给 /api/health 做自检用 */
export function inboxBackend() {
  return redisConfig() ? "redis" : "memory";
}

async function redisCommand(args) {
  const cfg = redisConfig();
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args.map(String)),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Redis HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  if (body && body.error) throw new Error(`Redis：${body.error}`);
  return body ? body.result : null;
}

/**
 * 追加一批采集记录。
 * 整批用一条 RPUSH 写进去（Redis 支持多值），避免逐条往返把批量采集拖慢。
 */
export async function inboxPush(records) {
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) return [];

  if (!redisConfig()) {
    mem.push(...list);
    while (mem.length > MAX) mem.shift();
    return list;
  }

  await redisCommand(["RPUSH", KEY, ...list.map((r) => JSON.stringify(r))]);
  await redisCommand(["LTRIM", KEY, String(-MAX), "-1"]);
  await redisCommand(["EXPIRE", KEY, String(TTL_SECONDS)]);
  return list;
}

/** 按时间顺序（老 → 新）取全部记录 */
export async function inboxList() {
  if (!redisConfig()) return mem.slice();

  const raw = await redisCommand(["LRANGE", KEY, "0", "-1"]);
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    try {
      out.push(typeof s === "string" ? JSON.parse(s) : s);
    } catch {
      // 坏数据直接跳过，不能让一条脏记录把整个列表带崩
    }
  }
  return out;
}

/** 按 id 删除；返回删除条数 */
export async function inboxRemove(ids) {
  const set = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!set.size) return 0;

  if (!redisConfig()) {
    let removed = 0;
    for (let i = mem.length - 1; i >= 0; i--) {
      if (set.has(String(mem[i].id))) {
        mem.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  // 列表最多 200 条，整体读出来过滤再写回，比逐条 LREM 更简单也更可控
  const all = await inboxList();
  const kept = all.filter((x) => !set.has(String(x.id)));
  const removed = all.length - kept.length;
  if (!removed) return 0;

  await redisCommand(["DEL", KEY]);
  if (kept.length) {
    await redisCommand(["RPUSH", KEY, ...kept.map((x) => JSON.stringify(x))]);
    await redisCommand(["EXPIRE", KEY, String(TTL_SECONDS)]);
  }
  return removed;
}

/** 清空收件箱；返回清掉的条数 */
export async function inboxReset() {
  if (!redisConfig()) {
    const n = mem.length;
    mem.length = 0;
    return n;
  }
  const all = await inboxList();
  await redisCommand(["DEL", KEY]);
  return all.length;
}
