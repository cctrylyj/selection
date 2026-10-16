/** 渠道适配器注册表 */

import { getEnv, hasEnv } from "../lib/env.js";
import { ChannelError } from "../lib/errors.js";
import * as samsclub from "./samsclub.js";
import * as amazon from "./amazon.js";
import * as tiktokshop from "./tiktokshop.js";

const ADAPTERS = {
  samsclub,
  amazon,
  tiktokshop,
};

export const DEFAULT_CHANNEL = "samsclub";

function configured(channelId) {
  switch (channelId) {
    case "samsclub":
      return hasEnv("BRIGHTDATA_API_TOKEN");
    case "amazon":
      return (
        hasEnv("AMAZON_ACCESS_KEY") &&
        hasEnv("AMAZON_SECRET_KEY") &&
        hasEnv("AMAZON_PARTNER_TAG")
      );
    case "tiktokshop":
      return (
        hasEnv("TIKTOK_APP_KEY") &&
        hasEnv("TIKTOK_APP_SECRET") &&
        hasEnv("TIKTOK_ACCESS_TOKEN")
      );
    default:
      return false;
  }
}

export function listChannels() {
  return Object.values(ADAPTERS).map((a) => ({
    id: a.channel.id,
    label: a.channel.label,
    code: a.channel.code,
    supportsKeywordSearch: a.channel.supportsKeywordSearch,
    docs: a.channel.docs,
    configured: configured(a.channel.id),
  }));
}

export function getAdapter(channelId) {
  const adapter = ADAPTERS[channelId];
  if (!adapter) {
    throw new ChannelError(
      `未知渠道：${channelId}`,
      `可选渠道：${Object.keys(ADAPTERS).join(", ")}`
    );
  }
  return adapter;
}

/** 统一搜索入口，返回 { items, failed, total } */
export async function searchChannel(channelId, keyword, options = {}) {
  const adapter = getAdapter(channelId);
  const result = await adapter.search(keyword, options);
  if (Array.isArray(result)) {
    return { items: result, failed: [], total: result.length };
  }
  return {
    items: Array.isArray(result?.items) ? result.items : [],
    failed: Array.isArray(result?.failed) ? result.failed : [],
    total: result?.total ?? (result?.items?.length ?? 0),
  };
}
