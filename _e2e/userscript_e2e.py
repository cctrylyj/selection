"""Tampermonkey 采集脚本的真实性验证。

流程：
  1. 从系统下载 collector.user.js（走真实接口，确认端口自动填充）
  2. 在真实 Chrome 里把它注入商品页（等价于 Tampermonkey 加载后的效果）
  3. 点击页面上的「采集到选品系统」浮动按钮
  4. 校验后端收到商品

详情页与搜索页各跑一遍。
"""

import json
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8787/api"
DETAIL_PAGE = (ROOT / "_e2e" / "fake-product-page.html").as_uri()
SEARCH_PAGE = (ROOT / "_e2e" / "fake-search-page.html").as_uri()


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    ok = True

    script_url = f"{API}/products/collector-script?channel=samsclub"
    with urllib.request.urlopen(script_url, timeout=15) as r:
        script = r.read().decode("utf-8")
        ctype = r.headers.get("Content-Disposition", "")

    print("== 下载用户脚本 ==")
    if "javascript:" not in script and '"use strict"' not in script:
        print("   FAIL 脚本内容异常")
        return 1
    if "127.0.0.1:8787" not in script:
        print("   FAIL BASE 地址未正确填充")
        ok = False
    else:
        print("   ok   BASE 已填为本机 8787，下载头:", ctype)

    def run_case(name: str, page_uri: str, expect_gte: int, expect_sales: int | None = None) -> None:
        nonlocal ok
        before = {x["id"] for x in get_json(f"{API}/products/collect/pending")["data"]["items"]}
        print(f"== 场景：{name} ==")
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
            page = browser.new_context().new_page()
            page.goto(page_uri, wait_until="load")
            # 注入用户脚本（等价于 Tampermonkey 的 document-idle 注入）
            page.add_script_tag(content=script)
            page.wait_for_timeout(400)

            btn = page.locator("#sourcing-collector-btn")
            if btn.count() == 0:
                print("   FAIL 浮动按钮没有出现")
                ok = False
                browser.close()
                return
            print("   ok   浮动按钮已挂载，点击")
            btn.click()
            page.wait_for_timeout(2500)
            toast = page.evaluate(
                "() => { const ds = [...document.querySelectorAll('div')].filter(d => "
                "d.style && d.style.position === 'fixed' && d.style.zIndex === '2147483647'); "
                "return ds.map(d => d.textContent); }"
            )
            print("   页面提示:", toast)
            browser.close()

        items = get_json(f"{API}/products/collect/pending")["data"]["items"]
        fresh = [x for x in items if x["id"] not in before]
        print(f"   新增采集 {len(fresh)} 条")
        for x in fresh:
            p = x["product"]
            print(f"     - {p['channelKey']} | {p['price']} | sales={p.get('sales')} | {p['productName']}")
        if len(fresh) < expect_gte:
            ok = False
        if expect_sales is not None:
            got = [x["product"].get("sales") for x in fresh]
            if expect_sales not in got:
                ok = False
                print(f"   FAIL 详情页销量应为 {expect_sales}，实际 {got}")
            else:
                print(f"   ok   详情页销量取自 JSON-LD reviewCount = {expect_sales}")
        if not any(t and ("已采集" in t) for t in toast):
            print("   FAIL 没有成功提示")
            ok = False

    run_case("商品详情页（应采集单个）", DETAIL_PAGE, 1, expect_sales=3821)
    run_case("搜索结果页（应批量采集）", SEARCH_PAGE, 4)

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
