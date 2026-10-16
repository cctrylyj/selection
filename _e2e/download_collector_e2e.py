"""验证「下载采集脚本」按钮：点击后必须触发浏览器下载，而不是跳转出 404 页面。

断言四件事：
1. 点击后捕获到 download 事件，文件名为 sourcing-collector.user.js
2. 下载内容确实是用户脚本（含 ==UserScript== 头，且 BASE 已按当前端口填充、无占位符残留）
3. 下载内容与源站直连逐字节一致（注意：要按字节比，模板含中文，
   len(str) 是字符数会比字节数少 ~650，容易误判成"下载被截断"）
4. 点击后页面地址没有变化（没有发生路由跳转，也没出现"页面不存在"）
"""

import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

APP = "http://127.0.0.1:5173/products"
SCRIPT_URL = "http://127.0.0.1:5173/api/products/collector-script?channel=samsclub"


def main() -> int:
    ok = True
    out = Path(__file__).resolve().parent / "_dl_result.user.js"

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
        page = browser.new_context().new_page()
        page.goto(APP, wait_until="networkidle")

        print("== 点击「下载采集脚本」 ==")
        before_url = page.url
        link = page.locator("a.collector-download")
        if link.count() == 0:
            print("   FAIL 页面上找不到下载按钮")
            browser.close()
            return 1
        print(f"   链接 href: {link.first.get_attribute('href')}")

        with page.expect_download(timeout=15000) as dl_info:
            link.first.click()
        dl = dl_info.value
        print(f"   下载事件已触发，建议文件名: {dl.suggested_filename}")
        if dl.suggested_filename != "sourcing-collector.user.js":
            ok = False
            print("   FAIL 文件名不对")
        dl.save_as(str(out))

        page.wait_for_timeout(1000)
        if page.url != before_url:
            ok = False
            print(f"   FAIL 发生了页面跳转: {before_url} -> {page.url}")
        else:
            print(f"   页面未跳转（仍在 {page.url}）")
        if "页面不存在" in page.locator("body").inner_text():
            ok = False
            print("   FAIL 仍显示“页面不存在”")

        browser.close()

    print("\n== 下载内容检查（按字节） ==")
    raw = out.read_bytes()
    text = raw.decode("utf-8")
    has_header = "==UserScript==" in text
    no_leftover = "__BASE__" not in text and "__CHANNEL__" not in text
    has_base = "127.0.0.1:8787/api/products/collect" in text
    print(f"   大小: {len(raw)} 字节 / {len(text)} 字符；含 UserScript 头: {has_header}；"
          f"占位符已填充: {no_leftover}；BASE 正确: {has_base}")
    if not (has_header and no_leftover and has_base):
        ok = False
        print("   FAIL 下载内容不正确")
        browser.close()
        return 1

    # 与源站直连逐字节比对，排除下载被截断/改写
    req = urllib.request.Request(SCRIPT_URL, method="GET")
    with urllib.request.urlopen(req, timeout=15) as r:
        expected = r.read()
    same = raw == expected
    print(f"   与直连逐字节一致: {same}（直连 {len(expected)} 字节）")
    if not same:
        ok = False
        print("   FAIL 下载内容与源不一致")
    out.unlink(missing_ok=True)

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
