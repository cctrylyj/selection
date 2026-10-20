/**
 * 图片代理（/api/proxy/image）的地址校验与稳定性测试。
 *
 * 这个接口等于一个开放代理，两个点必须守住：
 *   1. 不能把内网地址暴露出去（否则就是内网探针）；
 *   2. 非法参数只能返回 400，绝不能把进程带走。
 * 第 2 条是真实踩过的坑：校验原本写在 try 外面，async 里抛错变成未处理的
 * Promise 拒绝，Node 22 直接终止进程——一个畸形 url 就能把整个 API 打挂。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../app.js";
import { assertPublicUrl } from "../routes/image.js";

test("私网 / 环回地址一律拒绝", () => {
  const blocked = [
    "http://127.0.0.1/a.png",
    "http://127.10.20.30/a.png",
    "http://localhost/a.png",
    "http://10.0.0.5/a.png",
    "http://192.168.1.9/a.png",
    "http://172.16.3.4/a.png",
    "http://172.31.255.1/a.png",
    "http://169.254.1.1/a.png",
    "http://[::1]/a.png",
  ];
  for (const url of blocked) {
    assert.throws(() => assertPublicUrl(url), /不允许访问内网地址/, `应拒绝 ${url}`);
  }
});

test("非 http(s) 协议与畸形地址拒绝", () => {
  assert.throws(() => assertPublicUrl("file:///c:/windows/win.ini"), /只支持 http\/https/);
  assert.throws(() => assertPublicUrl("ftp://example.com/a.png"), /只支持 http\/https/);
  assert.throws(() => assertPublicUrl("javascript:alert(1)"), /只支持 http\/https/);
  assert.throws(() => assertPublicUrl("not a url"), /不合法/);
  assert.throws(() => assertPublicUrl(""), /不合法/);
  assert.throws(() => assertPublicUrl(undefined), /不合法/);
});

test("公网图片地址放行", () => {
  const url = assertPublicUrl("https://scene7.samsclub.com/is/image/samsclub/0001234p?fmt=jpg");
  assert.equal(url.hostname, "scene7.samsclub.com");
  assert.equal(url.protocol, "https:");
});

test("非法 url 返回 400 JSON，且不会打挂进程", async () => {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/proxy/image?url=${encodeURIComponent("http://127.0.0.1/secret.png")}`
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "BAD_URL");

    // 关键断言：进程还活着，后续请求照常响应
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    server.close();
  }
});
