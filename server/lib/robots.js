/**
 * robots.txt 检查 —— 「严格按照安全协议爬取」的落地实现。
 *
 * 每个抓取动作前都先过 isAllowed()，被 Disallow 的路径直接拒绝，
 * 不会发出请求。规则按最长前缀匹配（robots.txt 2.0 行为），User-agent 取 * 组。
 */

import { getEnv } from "./env.js";
import { TtlCache } from "./cache.js";

const cache = new TtlCache(24 * 60 * 60 * 1000); // robots 规则缓存 24h

/** 解析一个 robots.txt 内容，返回 { allows: string[], disallows: string[] } */
function parseRobots(text) {
  const groups = [];
  let current = null;
  let collecting = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      const isWild = value === "*";
      if (isWild) {
        if (!current) {
          current = { allows: [], disallows: [] };
          groups.push(current);
        }
        collecting = true;
      } else {
        collecting = false;
      }
      continue;
    }

    if (!collecting || !current) continue;
    if (field === "disallow" && value) current.disallows.push(value);
    else if (field === "allow" && value) current.allows.push(value);
  }

  // * 组通常在最前，但也可能分散；合并所有 * 组
  const merged = { allows: [], disallows: [] };
  for (const g of groups) {
    merged.allows.push(...g.allows);
    merged.disallows.push(...g.disallows);
  }
  return merged;
}

/** 最长前缀匹配：allow 与 disallow 里取最长的那条决定结果 */
function longestMatch(path, rules) {
  let winner = null;
  let winnerLen = -1;
  const scan = (list, kind) => {
    for (const rule of list) {
      if (rule === "") continue;
      if (path.startsWith(rule) && rule.length > winnerLen) {
        winnerLen = rule.length;
        winner = kind;
      }
    }
  };
  scan(rules.allows, true);
  scan(rules.disallows, false);
  return winner;
}

async function fetchRobots(origin) {
  const key = `robots:${origin}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const timeout = Number(getEnv("ROBOTS_FETCH_TIMEOUT", "8000"));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`${origin}/robots.txt`, {
      signal: controller.signal,
      headers: { "User-Agent": "sourcing-system/1.0 (+selective product data tool)" },
    });
    clearTimeout(timer);

    if (!res.ok) {
      // 取不到 robots.txt 时视为「无限制」
      const open = { allows: [], disallows: [] };
      cache.set(key, open);
      return open;
    }
    const rules = parseRobots(await res.text());
    cache.set(key, rules);
    return rules;
  } catch {
    // 网络失败：宁可放行也不要因为 robots 拉不下来让整个系统不可用
    const open = { allows: [], disallows: [] };
    cache.set(key, open);
    return open;
  }
}

/**
 * 判断某 URL 是否允许抓取。
 * @returns {Promise<{allowed: boolean, rule: string}>}
 */
export async function isAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { allowed: false, rule: "invalid url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { allowed: false, rule: "non-http protocol" };
  }

  const origin = u.origin;
  const rules = await fetchRobots(origin);
  const path = u.pathname + u.search;

  const verdict = longestMatch(path, rules);
  if (verdict === false) {
    const rule = rules.disallows.find((r) => r && path.startsWith(r)) || "";
    return { allowed: false, rule };
  }
  return { allowed: true, rule: rules.allows.find((r) => r && path.startsWith(r)) || "-" };
}

/** 用法包装：不允许时直接抛错，避免调用方忘记检查 */
export async function assertAllowed(url) {
  const res = await isAllowed(url);
  if (!res.allowed) {
    throw new ConfigError(
      `目标路径被 robots.txt 禁止抓取：${new URL(url).pathname}`,
      `命中规则 Disallow: ${res.rule}。系统不抓取协议不允许的内容；请改用官方 API 或已授权数据集。`
    );
  }
  return res;
}

export { parseRobots };
