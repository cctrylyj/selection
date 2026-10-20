"""列表页（搜索结果页）书签采集的端到端验证。

合成一个带 /ip/ 商品卡片的搜索页，用真实 Chrome 打开后执行书签脚本，
验证批量采集接口收到全部商品并正确解析。

价格部分是回归重点：fixture 里有两种山姆真实的价格 DOM——
「大字整数 + 小字角分」拆成多个节点（$ / 19 / 98），以及单节点 $24.98。
曾经的 bug 是把前者粘成 "$1998"（或只读到整数 19），这里必须还原成 19.98。

销量部分是新增回归点：星级右边那个数字（★★★★★ 6754）要采下来，
而星级值 4.6（小数）与卡片里 "starting price" 容器中的拆分价格 12 / 34
都绝不能被当成销量。
"""

import json
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8787/api"
PAGE = (ROOT / "_e2e" / "fake-search-page.html").as_uri()


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    ok = True

    info = get_json(f"{API}/products/collect-info?channel=samsclub")["data"]
    script = info["bookmarklet"][len("javascript:"):]
    print(f"采集地址: {info['collectUrl']}")

    # 记录当前收件箱末尾，便于只校验本次新增
    before = get_json(f"{API}/products/collect/pending")["data"]["items"]
    before_ids = {x["id"] for x in before}

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
        page = browser.new_context().new_page()
        page.goto(PAGE, wait_until="load")
        page.evaluate(
            "() => { window.__toasts = []; const obs = new MutationObserver(() => {"
            " document.querySelectorAll('div').forEach(d => {"
            " if (d.style && d.style.position === 'fixed' && d.style.zIndex === '2147483647')"
            " window.__toasts.push(d.textContent); }); });"
            " obs.observe(document.documentElement, { childList: true, subtree: true }); }"
        )
        page.evaluate(script)
        page.wait_for_timeout(3000)
        toasts = page.evaluate("() => window.__toasts")
        print("页面提示:", toasts)
        browser.close()

    after = get_json(f"{API}/products/collect/pending")["data"]["items"]
    fresh = [x for x in after if x["id"] not in before_ids]
    print(f"新增采集: {len(fresh)} 条")

    expect = [
        # channelKey, 价格, 销量, 名称片段
        ("98001111", 19.98, 6754, "Red Roses Bouquet, 12 Stems"),
        ("98002222", 24.98, 1234, "White Lily Potted Plant"),
        ("98003333", None, None, "Phalaenopsis Orchid Pot"),
        ("98004444", 16.48, 1200, "Mixed Spring Bouquet"),
    ]
    got = {x["product"]["channelKey"]: x["product"] for x in fresh}
    for key, price, sales, name in expect:
        p = got.get(key)
        if not p:
            print(f"   FAIL 缺少 {key}")
            ok = False
            continue
        same_price = p.get("price") == price
        if not same_price or not name.split(",")[0] in p.get("productName", ""):
            ok = False
        print(f"   {'ok  ' if same_price else 'FAIL'} {key}: price={p.get('price')} name={p.get('productName')}")
        # 币种也要跟着拆分结构里那个上标 $ 走
        if price is not None and p.get("currency") != "USD":
            ok = False
            print(f"   FAIL {key} 币种应为 USD，实际 {p.get('currency')}")

        same_sales = p.get("sales") == sales
        if not same_sales:
            ok = False
        print(f"   {'ok  ' if same_sales else 'FAIL'} {key}: sales={p.get('sales')}（应为 {sales}）")

    if not any(t and "已采集本页" in t for t in toasts):
        print("   FAIL 没看到批量采集成功提示")
        ok = False

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
