/**
 * Bright Data Dataset API（数据集触发 + 快照轮询）。
 * 用于「官方 API 覆盖不到的站点」，例如山姆的关键词搜索：
 * samsclub.com/robots.txt 明确 Disallow: /search，所以关键词检索不能自己抓，
 * 改由数据服务商在受控环境里产出的数据集提供。
 *
 * 文档：https://docs.brightdata.com/datasets/trigger-a-dataset
 */

import { getEnv, requireEnv } from "../../lib/env.js";
import { ChannelError } from "../../lib/errors.js";

const API = "https://api.brightdata.com/datasets/v3";

export function isDatasetConfigured() {
  return Boolean(getEnv("BRIGHTDATA_API_TOKEN") && getEnv("SAMS_DATASET_ID"));
}

/**
 * 触发数据集采集并等快照就绪。
 * @param {string} datasetId
 * @param {Array<object>} input 数据集要求的输入（不同 collector 字段不同）
 * @param {{timeoutMs?: number}} opts
 * @returns {Promise<Array<object>>} 数据集返回的行
 */
export async function triggerDataset(datasetId, input, opts = {}) {
  const token = requireEnv(
    "BRIGHTDATA_API_TOKEN",
    "Bright Data 控制台 → Account settings → API tokens。"
  );
  const timeoutMs = opts.timeoutMs ?? 180000;

  const triggerUrl =
    `${API}/trigger?dataset_id=${encodeURIComponent(datasetId)}&notify=false&type=trigger`;
  const triggerRes = await fetchWithTimeout(triggerUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, 60000);

  if (!triggerRes.ok) {
    throw new ChannelError(
      `数据集触发失败 HTTP ${triggerRes.status}`,
      (await triggerRes.text()).slice(0, 300)
    );
  }
  const snapshotId = (await triggerRes.json())?.snapshot_id;
  if (!snapshotId) throw new ChannelError("数据集未返回 snapshot_id", "请确认 dataset_id 是否正确。");

  // 轮询快照
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(3000);
    const snapRes = await fetchWithTimeout(
      `${API}/snapshot/${encodeURIComponent(snapshotId)}?format=json`,
      { headers: { Authorization: `Bearer ${token}` } },
      60000
    );
    if (!snapRes.ok) continue;
    const text = await snapRes.text();
    if (!text || text === "null") continue;
    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      continue;
    }
    if (Array.isArray(rows)) return rows;
    if (rows && typeof rows === "object") return [rows];
  }
  throw new ChannelError("数据集快照等待超时", `已在 ${Math.round(timeoutMs / 1000)}s 内轮询 ${snapshotId}。`);
}

function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
