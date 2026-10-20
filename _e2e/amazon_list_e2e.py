"""亚马逊搜索结果页采集验证（无登录、书签通道）。

背景：旧版采集器的列表模式只认山姆的 /ip/ 链接，在亚马逊 /dp/ 页面上一条都
匹配不到，于是退化成「整页当一个商品」，采出来是
"Amazon.com: Flowers - $5 To $25"、价格/图片/销量全空。

本用例把 amazon.com/s?k=flowers 拦截成本地 fixture（结构按中文站点复刻），
用真实 Chrome 执行书签脚本，验证：
  1. 逐卡片解析出 4 个商品（广告位 data-asin="" 被跳过）
  2. 价格取现价而不是划线原价；全角 ￥ 识别成 CNY，$ / US$ 识别成 USD
  3. 评价数优先（5K → 5000），没有评价链接时退回「过去一个月购买了 1.2K 件」
  4. 商品名是商品标题，不再是页面标题
  5. 列表页解析不到卡片时给出提示，不产生垃圾数据
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8787/api"
FIXTURE = (ROOT / "_e2e" / "fake-amazon-search.html").read_text(encoding="utf-8")

EMPTY_PAGE = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Amazon.com: 没有找到结果</title></head>
<body><div>没有找到与 "zzzz" 相关的结果</div></body></html>"""


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    ok = True

    info = get_json(f"{API}/products/collect-info?channel=amazon")["data"]
    script = info["bookmarklet"][len("javascript:"):]

    before = get_json(f"{API}/products/collect/pending")["data"]["items"]
    before_ids = {x["id"] for x in before}

    observe = (
        "() => { window.__toasts = []; const obs = new MutationObserver(() => {"
        " document.querySelectorAll('div').forEach(d => {"
        " if (d.style && d.style.position === 'fixed' && d.style.zIndex === '2147483647')"
        " window.__toasts.push(d.textContent); }); });"
        " obs.observe(document.documentElement, { childList: true, subtree: true }); }"
    )

    with sync_playwright() as p:
        # Chrome 138+ 的 Local Network Access：从公网站点（amazon.com）请求
        # 127.0.0.1 会先要用户授权，headless 下没人点「允许」→ 请求直接失败。
        # 真实浏览器里用户点一次允许即可（服务端也已回 Access-Control-Allow-Private-Network），
        # 测试里把这个检查关掉，否则测的就不是采集逻辑而是权限弹窗。
        browser = p.chromium.launch(
            channel="chrome",
            headless=True,
            args=["--disable-extensions", "--disable-features=LocalNetworkAccessChecks"],
        )

        # ---- 1. 有商品的搜索页 ----
        page = browser.new_context().new_page()
        page.route(
            re.compile(r"https://www\.amazon\.com/s\?k=flowers"),
            lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=FIXTURE),
        )
        page.route("https://cdn.example.com/**", lambda route: route.abort())
        page.goto("https://www.amazon.com/s?k=flowers", wait_until="domcontentloaded")
        page.evaluate(observe)
        page.evaluate(script)
        page.wait_for_timeout(3000)
        toasts = page.evaluate("() => window.__toasts")
        print("页面提示:", toasts)

        # ---- 2. 没有商品的搜索页：必须提示，不能把页面标题当商品 ----
        page2 = browser.new_context().new_page()
        page2.route(
            re.compile(r"https://www\.amazon\.com/s\?k=zzzz"),
            lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=EMPTY_PAGE),
        )
        page2.goto("https://www.amazon.com/s?k=zzzz", wait_until="domcontentloaded")
        page2.evaluate(observe)
        page2.evaluate(script)
        page2.wait_for_timeout(2000)
        toasts2 = page2.evaluate("() => window.__toasts")
        print("空结果页提示:", toasts2)
        browser.close()

    after = get_json(f"{API}/products/collect/pending")["data"]["items"]
    fresh = [x for x in after if x["id"] not in before_ids]
    print(f"新增采集: {len(fresh)} 条（应为 4）")
    if len(fresh) != 4:
        ok = False
        print("   FAIL 采集条数不对")
        for x in fresh:
            print("      ", x["product"].get("productName"), x["product"].get("channelKey"))

    got = {x["product"]["channelKey"]: x["product"] for x in fresh}

    # ASIN, 价格, 币种, 销量, 名称片段
    expect = [
        ("B0TEST0001", 169.99, "CNY", 5000, "秋季人造花卉"),
        ("B0TEST0002", 15.99, "USD", 1200, "人造秋菊花"),
        ("B0TEST0003", 23.99, "USD", 300, "人造悬挂花环"),
        ("B0TEST0004", None, None, 800, "仿真牡丹花束"),
    ]
    for key, price, currency, sales, name in expect:
        item = got.get(key)
        if not item:
            ok = False
            print(f"   FAIL 缺少 {key}")
            continue
        same = item.get("price") == price
        print(f"   {'ok  ' if same else 'FAIL'} {key}: price={item.get('price')}（应为 {price}）"
              f" currency={item.get('currency')}")
        if not same:
            ok = False
        if currency and item.get("currency") != currency:
            ok = False
            print(f"   FAIL {key} 币种应为 {currency}，实际 {item.get('currency')}")
        if item.get("sales") != sales:
            ok = False
            print(f"   FAIL {key} 销量应为 {sales}，实际 {item.get('sales')}")
        if name not in (item.get("productName") or ""):
            ok = False
            print(f"   FAIL {key} 名称不对：{item.get('productName')}")
        if not item.get("imageUrl"):
            ok = False
            print(f"   FAIL {key} 没有图片")

    # 广告位不能被采进来
    if "B0ADAD0001" in got:
        ok = False
        print("   FAIL 广告位卡片被采进来了")

    # 最关键的一条：不能再出现「页面标题当商品名」
    bad = [x["product"]["productName"] for x in fresh if "Amazon.com:" in (x["product"]["productName"] or "")]
    if bad:
        ok = False
        print(f"   FAIL 仍然把页面标题当商品：{bad}")

    if not any(t and "已采集本页 4 个商品" in t for t in toasts):
        ok = False
        print("   FAIL 没有看到「已采集本页 4 个商品」的提示")

    if not any(t and "列表页" in t for t in toasts2):
        ok = False
        print("   FAIL 空结果页没有给出「列表页解析不到卡片」的提示")

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
