/**
 * 采集收件箱存储层的离线测试。
 *
 * 只测「内存兜底」这条路（本地开发与单实例部署走的就是它）以及后端探测逻辑；
 * Redis 路径需要真实实例，由部署后的 /api/health 自检覆盖。
 */
import assert from "node:assert/strict";
import {
  inboxBackend,
  inboxPush,
  inboxList,
  inboxRemove,
  inboxReset,
} from "../lib/inboxStore.js";

const cases = [];
function t(name, fn) {
  cases.push([name, fn]);
}

t("没配 Redis 时走内存后端", () => {
  assert.equal(inboxBackend(), "memory");
});

t("配了 KV_* 或 UPSTASH_* 就认成 redis（不真的连）", () => {
  const saved = { ...process.env };
  try {
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "tok";
    assert.equal(inboxBackend(), "redis");

    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
    assert.equal(inboxBackend(), "redis");

    // 只有 URL 没有 token 不算配好
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    assert.equal(inboxBackend(), "memory");
  } finally {
    for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
      delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
});

t("写入 / 读取：整批写入且保持「老的在前」的顺序", async () => {
  await inboxReset();
  await inboxPush([{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.deepEqual((await inboxList()).map((x) => x.id), ["a", "b", "c"]);
});

t("按 id 删除，返回删除条数；不存在的 id 不影响", async () => {
  await inboxReset();
  await inboxPush([{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.equal(await inboxRemove(["b", "nope"]), 1);
  assert.deepEqual((await inboxList()).map((x) => x.id), ["a", "c"]);
  assert.equal(await inboxRemove([]), 0);
});

t("上限 200：超出后丢掉最老的", async () => {
  await inboxReset();
  const many = Array.from({ length: 210 }, (_, i) => ({ id: `x${i}` }));
  await inboxPush(many);
  const all = await inboxList();
  assert.equal(all.length, 200);
  assert.equal(all[0].id, "x10", "最老的 10 条应被丢掉");
  assert.equal(all[199].id, "x209");
});

t("清空返回清掉的条数", async () => {
  await inboxReset();
  await inboxPush([{ id: "a" }, { id: "b" }]);
  assert.equal(await inboxReset(), 2);
  assert.equal((await inboxList()).length, 0);
});

t("空数组写入是安全的", async () => {
  await inboxReset();
  assert.deepEqual(await inboxPush([]), []);
  assert.equal((await inboxList()).length, 0);
});

let passed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    passed++;
    console.log("  ok -", name);
  } catch (e) {
    console.error("  FAIL -", name);
    console.error("   ", e.message);
    process.exitCode = 1;
  }
}

console.log(`\n${passed} passed`);
