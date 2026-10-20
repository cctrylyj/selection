"""跨渠道连续采集验证：先采山姆、再采亚马逊，两批都不能丢、不能串。

为什么单独做这个用例：
  之前的 e2e 都是「单渠道单次采集」，从来没有验证过「同一个页面会话里
  先采完山姆再采亚马逊」。而用户实际就是这么用的——采完山姆切到亚马逊接着采。
  跨渠道的风险点恰好都在「状态」上：
    - 书签里的渠道是 DEFAULT_CH + URL 正则推断的，切站点后会不会还沿用上一批？
    - 收件箱游标（sinceId）按 id 字符串比大小，第二批 id 若比游标小就会被当成已读；
    - 前端轮询只 append，如果游标推进错了，第二批会被整批丢掉；
    - 两个渠道的 channelKey 空间不同（山姆 /ip/98001111 vs 亚马逊 /dp/B0TEST0001），
      行 key 若只用 channelKey 就会跨渠道撞车。

覆盖矩阵：
  1. 书签通道   山姆列表 → 亚马逊列表（用户原话的顺序）
  2. 书签通道   亚马逊列表 → 山姆列表（反向，确认不是「只能按某个顺序」）
  3. 用户脚本   山姆列表 → 亚马逊列表（Tampermonkey 是两条模板，要各自验证）
  4. 详情页混合 山姆详情 → 亚马逊列表（详情页走的是另一条提交路径）

每组都断言：收件箱新增条数、每条 channel 正确、channelKey 不与另一渠道重复、
前端表格行数与出现顺序都符合预期。
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8787/api"
APP = "http://127.0.0.1:5173/products"

SAMS_LIST = (ROOT / "_e2e" / "fake-search-page.html").read_text(encoding="utf-8")
AMZ_LIST = (ROOT / "_e2e" / "fake-amazon-search.html").read_text(encoding="utf-8")
SAMS_DETAIL = (ROOT / "_e2e" / "fake-product-page.html").read_text(encoding="utf-8")

SAMS_URL = "https://www.samsclub.com/s/flowers"
AMZ_URL = "https://www.amazon.com/s?k=flowers"
SAMS_DETAIL_URL = "https://www.samsclub.com/ip/member-s-mark-bath-tissue/980012345"

# 两个 fixture 各自的商品（channelKey → 名称片段）
SAMS_KEYS = ["98001111", "98002222", "98003333", "98004444"]
AMZ_KEYS = ["B0TEST0001", "B0TEST0002", "B0TEST0003", "B0TEST0004"]

# 两个 fixture 的商品名关键词，用来核对「山姆那批在前、亚马逊那批在后」
SAMS_NAMES = ["Red Roses Bouquet", "White Lily Potted Plant", "Phalaenopsis Orchid Pot", "Mixed Spring Bouquet"]
AMZ_NAMES = ["Lifewit", "RECUTMS", "花环", "牡丹花束"]

# 字段级期望：channelKey → (价格, 币种, 销量)
# 山姆那批来自 fake-search-page.html（拆分价格 19/98 + 划线原价 + 缺价卡片）
SAMS_FIELDS = {
    "98001111": (19.98, "USD", 6754),
    "98002222": (24.98, "USD", 1234),
    "98003333": (None, "USD", None),   # 卡片没有价格，必须留空而不是 0
    "98004444": (16.48, "USD", 1200),
}
# 亚马逊那批来自 fake-amazon-search.html：
#   B0TEST0001 划线价 ￥199.99 + 现价 ￥169.99 → 必须取现价、识别成全角 ￥ = CNY
#   B0TEST0002 只有 $15.99，评价链接缺失 → 销量从「过去一个月购买了 1.2K 件」取 1200
#   B0TEST0003 "US$23.99" → USD
#   B0TEST0004 「当前无法配送」→ 价格留空、销量 800
AMZ_FIELDS = {
    "B0TEST0001": (169.99, "CNY", 5000),
    "B0TEST0002": (15.99, "USD", 1200),
    "B0TEST0003": (23.99, "USD", 300),
    "B0TEST0004": (None, "USD", 800),
}


def check_fields(items, expect: dict, label: str) -> bool:
    """逐条核对价格 / 币种 / 销量，返回是否全部通过。"""
    good = True
    got = {x["product"]["channelKey"]: x["product"] for x in items}
    for key, (price, currency, sales) in expect.items():
        p = got.get(key)
        if not p:
            print(f"   FAIL {label} 缺少 {key}")
            good = False
            continue
        if p["price"] != price:
            print(f"   FAIL {label} {key} 价格 {p['price']}（应为 {price}）")
            good = False
        if price is not None and p["currency"] != currency:
            print(f"   FAIL {label} {key} 币种 {p['currency']}（应为 {currency}）")
            good = False
        if p["sales"] != sales:
            print(f"   FAIL {label} {key} 销量 {p['sales']}（应为 {sales}）")
            good = False
        if not p.get("imageUrl"):
            # 图片在 fixture 里被 route abort 了，src 属性仍然存在；
            # 这里只要求字段非空，不要求真能加载
            print(f"   FAIL {label} {key} 图片字段为空")
            good = False
    return good

# 山姆详情页 fixture 的 sku/mpn（parseProduct 用 sku 优先做 channelKey）
SAMS_DETAIL_KEY = "1425143980"

OBSERVE_JS = (
    "() => { window.__toasts = []; const obs = new MutationObserver(() => {"
    " document.querySelectorAll('div').forEach(d => {"
    " if (d.style && d.style.position === 'fixed' && d.style.zIndex === '2147483647')"
    " window.__toasts.push(d.textContent); }); });"
    " obs.observe(document.documentElement, { childList: true, subtree: true }); }"
)


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def delete_inbox():
    req = urllib.request.Request(
        f"{API}/products/collect/inbox",
        data=json.dumps({"all": True}).encode(),
        headers={"Content-Type": "application/json"},
        method="DELETE",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def pending():
    return get_json(f"{API}/products/collect/pending?since=")["data"]["items"]


def bookmarklet(channel: str) -> str:
    info = get_json(f"{API}/products/collect-info?channel={channel}")["data"]
    return info["bookmarklet"][len("javascript:"):]


def userscript() -> str:
    with urllib.request.urlopen(f"{API}/products/collector-script?channel=samsclub", timeout=15) as r:
        return r.read().decode("utf-8")


def route_fixtures(page):
    """把两个站点的搜索页都拦成本地 fixture，其余静态资源直接 abort。"""
    page.route(
        re.compile(r"https://www\.samsclub\.com/s/flowers.*"),
        lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=SAMS_LIST),
    )
    page.route(
        re.compile(r"https://www\.samsclub\.com/ip/.*"),
        lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=SAMS_DETAIL),
    )
    page.route(
        re.compile(r"https://www\.amazon\.com/s\?k=flowers.*"),
        lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=AMZ_LIST),
    )
    page.route("https://scene7.samsclub.com/**", lambda route: route.abort())
    page.route("https://cdn.example.com/**", lambda route: route.abort())
    page.route("https://m.media-amazon.com/**", lambda route: route.abort())


def collect_via_bookmarklet(page, script: str, url: str) -> None:
    """在当前标签页跳到目标站，然后执行书签脚本（等价于用户点书签）。"""
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_load_state("load")
    page.evaluate(OBSERVE_JS)
    page.evaluate(script)
    page.wait_for_timeout(2500)


def collect_via_userscript(page, script: str, url: str) -> None:
    """注入 Tampermonkey 脚本后点页面右下角的浮动按钮。"""
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_load_state("load")
    page.evaluate(OBSERVE_JS)
    page.add_script_tag(content=script)
    page.wait_for_timeout(600)
    btn = page.locator("#sourcing-collector-btn")
    if btn.count() == 0:
        raise RuntimeError("浮动按钮没有挂上（用户脚本未生效）")
    btn.click()
    page.wait_for_timeout(2500)


def table_rows(page):
    """前端表格里的名称列表（按显示顺序）"""
    return page.evaluate(
        "() => [...document.querySelectorAll('.ant-table-tbody .cell-product')].map(e => e.textContent.trim())"
    )


def main() -> int:
    ok = True
    book_sams = bookmarklet("samsclub")
    book_amz = bookmarklet("amazon")
    tm = userscript()

    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="chrome",
            headless=True,
            args=["--disable-extensions", "--disable-features=LocalNetworkAccessChecks"],
        )

        def new_page(ctx):
            page = ctx.new_page()
            route_fixtures(page)
            return page

        def open_app(ctx):
            """系统页面单独一个标签页常驻（模拟用户把系统页开在一边，去商品页采集）。

            关键：不能复用同一个 page 去 goto 目标站点——那样系统页面就不存在了，
            表格自然查不到。前端轮询是常开的，只要页面在，采集到的数据会自动出现。
            """
            app = new_page(ctx)
            app.goto(APP, wait_until="networkidle")
            app.wait_for_timeout(2600)  # 等静默基线落定
            return app

        def run_case(title, steps):
            """通用跑法：开系统页 → 依次执行采集步骤 → 校验收件箱与前端表格。"""
            nonlocal ok
            print(f"\n== {title} ==")
            delete_inbox()
            ctx = browser.new_context()
            app = open_app(ctx)
            collector = new_page(ctx)

            for label, fn, url in steps:
                fn(collector, url)
                n = len(pending())
                print(f"   {label}采完，收件箱 {n} 条")

            app.wait_for_timeout(5000)  # 等前端把两批都轮询回来
            rows = table_rows(app)
            total = len(pending())
            print(f"   最终：收件箱 {total} 条 / 前端表格 {len(rows)} 行")
            if len(rows) != total:
                ok = False
                print(f"   FAIL 前端行数({len(rows)}) 与收件箱({total}) 不一致——第二批被吞？")

            by_ch = {}
            for x in pending():
                by_ch.setdefault(x["product"]["channel"], []).append(x["product"]["channelKey"])

            # 行 key 唯一：跨渠道 channelKey 撞车会让行互相覆盖
            keys = [f"{x['product']['channel']}:{x['product']['channelKey']}" for x in pending()]
            if len(set(keys)) != len(keys):
                ok = False
                print("   FAIL 跨渠道 channelKey 重复，行 key 会撞车")

            ctx.close()
            return rows, by_ch

        # ================= 场景 1：书签 山姆 → 亚马逊 =================
        rows, by_ch = run_case("场景 1：书签通道  山姆列表 → 亚马逊列表", [
            ("山姆", lambda pg, u: collect_via_bookmarklet(pg, book_sams, u), SAMS_URL),
            ("亚马逊", lambda pg, u: collect_via_bookmarklet(pg, book_amz, u), AMZ_URL),
        ])
        print(f"   渠道分布: { {k: len(v) for k, v in by_ch.items()} }")
        if sorted(by_ch.get("samsclub", [])) != sorted(SAMS_KEYS):
            ok = False
            print(f"   FAIL 山姆 channelKey 不对: {by_ch.get('samsclub')}")
        if sorted(by_ch.get("amazon", [])) != sorted(AMZ_KEYS):
            ok = False
            print(f"   FAIL 亚马逊 channelKey 不对: {by_ch.get('amazon')}")

        # 字段级：两批都要各自解析正确，不能互相污染（比如亚马逊用了山姆的价格解析）
        items1 = pending()
        if not check_fields([x for x in items1 if x["product"]["channel"] == "samsclub"], SAMS_FIELDS, "山姆"):
            ok = False
        if not check_fields([x for x in items1 if x["product"]["channel"] == "amazon"], AMZ_FIELDS, "亚马逊"):
            ok = False
        print("   ok   两批字段（价格/币种/销量/图片）逐条核对通过"
              if ok else "   ↑ 字段核对有失败项")
        # 顺序：山姆 4 条在前、亚马逊 4 条在后（用户就是按这个顺序采的）
        sams_part, amz_part = rows[:4], rows[4:]
        order_ok = (
            all(any(k in r for k in SAMS_NAMES) for r in sams_part)
            and all(any(k in r for k in AMZ_NAMES) for r in amz_part)
        )
        print(f"   {'ok  ' if order_ok else 'FAIL'} 显示顺序（山姆 4 条在前，亚马逊 4 条在后）")
        if not order_ok:
            ok = False
            print(f"      实际: {rows}")

        # ================= 场景 2：书签 亚马逊 → 山姆（反向） =================
        rows2, by_ch2 = run_case("场景 2：书签通道  亚马逊列表 → 山姆列表（反向顺序）", [
            ("亚马逊", lambda pg, u: collect_via_bookmarklet(pg, book_amz, u), AMZ_URL),
            ("山姆", lambda pg, u: collect_via_bookmarklet(pg, book_sams, u), SAMS_URL),
        ])
        print(f"   渠道分布: { {k: len(v) for k, v in by_ch2.items()} }")
        if len(by_ch2.get("amazon", [])) != 4 or len(by_ch2.get("samsclub", [])) != 4:
            ok = False
            print("   FAIL 反向下渠道归属不对")

        # ================= 场景 3：用户脚本 山姆 → 亚马逊 =================
        rows3, by_ch3 = run_case("场景 3：用户脚本（Tampermonkey） 山姆列表 → 亚马逊列表", [
            ("山姆", lambda pg, u: collect_via_userscript(pg, tm, u), SAMS_URL),
            ("亚马逊", lambda pg, u: collect_via_userscript(pg, tm, u), AMZ_URL),
        ])
        print(f"   渠道分布: { {k: len(v) for k, v in by_ch3.items()} }")
        if sorted(by_ch3.get("samsclub", [])) != sorted(SAMS_KEYS):
            ok = False
            print(f"   FAIL 山姆 channelKey 不对: {by_ch3.get('samsclub')}")
        if sorted(by_ch3.get("amazon", [])) != sorted(AMZ_KEYS):
            ok = False
            print(f"   FAIL 亚马逊 channelKey 不对: {by_ch3.get('amazon')}")
        items3 = pending()
        if not check_fields([x for x in items3 if x["product"]["channel"] == "samsclub"], SAMS_FIELDS, "山姆"):
            ok = False
        if not check_fields([x for x in items3 if x["product"]["channel"] == "amazon"], AMZ_FIELDS, "亚马逊"):
            ok = False

        # ================= 场景 4：山姆详情页 → 亚马逊列表 =================
        rows4, by_ch4 = run_case("场景 4：书签通道  山姆详情页 → 亚马逊列表", [
            ("山姆详情页", lambda pg, u: collect_via_bookmarklet(pg, book_sams, u), SAMS_DETAIL_URL),
            ("亚马逊", lambda pg, u: collect_via_bookmarklet(pg, book_amz, u), AMZ_URL),
        ])
        detail = [x for x in pending() if x["product"]["channel"] == "samsclub"][0]["product"]
        print(f"   详情页商品: {detail['productName']} / {detail['price']}{detail['currency']} / key={detail['channelKey']}")
        if detail["price"] != 24.98:
            ok = False
            print("   FAIL 详情页价格不对")
        if len(by_ch4.get("amazon", [])) != 4:
            ok = False
            print("   FAIL 详情页之后亚马逊那批没采到")

        browser.close()

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
