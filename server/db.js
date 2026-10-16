/**
 * Supabase 客户端。
 * 只在后端使用 service_role 密钥 —— 该密钥绕开 RLS，等价于管理员权限，
 * 因此严禁在前端代码、日志、错误信息中出现。
 */

import { createClient } from "@supabase/supabase-js";
import { getEnv, looksLikePlaceholder } from "./lib/env.js";
import { DbError } from "./lib/errors.js";

export const TABLE = "selections";

let client = null;

export function getDb() {
  if (client) return client;

  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  const urlPlaceholder = looksLikePlaceholder(url);
  const keyPlaceholder = looksLikePlaceholder(key);

  if (!urlPlaceholder && !keyPlaceholder && !/^https:\/\/.+/.test(url)) {
    throw new DbError(
      "SUPABASE_URL 格式不正确",
      `应为 https://<project-ref>.supabase.co，当前值：${url}`
    );
  }

  if (urlPlaceholder || keyPlaceholder) {
    const missing = [urlPlaceholder ? "SUPABASE_URL" : "", keyPlaceholder ? "SUPABASE_SERVICE_ROLE_KEY" : ""]
      .filter(Boolean)
      .join(" 和 ");
    throw new DbError(
      `数据库未配置（${missing} 仍是 .env.example 里的占位值）`,
      "请复制 .env.example 为 .env，填入你自己的 Supabase 项目地址和 service_role 密钥；"
      + "然后在 Supabase SQL Editor 里执行项目 sql/001_selections.sql 建表。"
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "sourcing-system" } },
  });
  return client;
}

/** 探活：返回 { ok, message }，不抛异常 */
export async function pingDb() {
  try {
    const db = getDb();
    const { error } = await db.from(TABLE).select("id", { count: "exact", head: true });
    if (error) {
      return { ok: false, message: `${error.code ?? ""} ${error.message}`.trim() };
    }
    return { ok: true, message: "connected" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
