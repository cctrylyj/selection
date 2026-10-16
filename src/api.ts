import {
  ApiError,
  type AddResult,
  type ChannelInfo,
  type CollectedItem,
  type CollectInfo,
  type Product,
  type SearchResult,
  type SelectionItem,
} from "./types";

const BASE = "/api";

interface Envelope<T> {
  ok: true;
  data: T;
}

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; hint?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("网络请求失败，请确认后端已启动", "NETWORK");
  }

  let body: Envelope<T> | ErrorEnvelope;
  try {
    body = (await res.json()) as Envelope<T> | ErrorEnvelope;
  } catch {
    throw new ApiError(`服务返回异常（HTTP ${res.status}）`, "BAD_RESPONSE");
  }

  if (body.ok) return body.data;
  throw new ApiError(
    body.error?.message || "请求失败",
    body.error?.code || "API_ERROR",
    body.error?.hint || ""
  );
}

export const api = {
  channels: () => request<ChannelInfo[]>("/products/channels"),

  search: (channel: string, keyword: string) =>
    request<SearchResult>(
      `/products/search?channel=${encodeURIComponent(channel)}&keyword=${encodeURIComponent(keyword)}`
    ),

  listSelections: () =>
    request<{ items: SelectionItem[]; total: number; page: number; pageSize: number }>(
      "/selection?page=1&pageSize=200"
    ),

  addSelections: (items: Product[]) =>
    request<AddResult>("/selection", { method: "POST", body: JSON.stringify({ items }) }),

  removeSelections: (ids: string[]) =>
    request<{ removed: number; requested: number }>("/selection/remove", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  clearSelections: () =>
    request<{ removed: number }>("/selection/clear?confirm=yes", { method: "POST" }),

  // ---- 零凭证采集通道 ----

  collectInfo: (channel: string) =>
    request<CollectInfo>(`/products/collect-info?channel=${encodeURIComponent(channel)}`),

  pendingCollect: (since: string) =>
    request<{ items: CollectedItem[] }>(
      `/products/collect/pending${since ? `?since=${encodeURIComponent(since)}` : ""}`
    ),

  /** 删除采集记录：批量传 ids，或 all 清空 */
  deleteCollected: (body: { ids?: string[]; all?: boolean }) =>
    request<{ removed: number }>("/products/collect/inbox", {
      method: "DELETE",
      body: JSON.stringify(body),
    }),

  /** 粘贴导入：url / html / jsonld 三选一 */
  importProduct: (body: { channel: string; url?: string; html?: string; jsonld?: string }) =>
    request<CollectedItem>("/products/import", { method: "POST", body: JSON.stringify(body) }),
};
