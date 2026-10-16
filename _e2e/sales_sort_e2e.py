"""销量列 + 排序的 UI 级验证。

断言：
  1. 表格里有「销量」列，数值按千分位展示（6754 → 6,754）
  2. 没有销量的商品显示「—」，不是 0
  3. 点「销量」表头能升序 / 降序排序
  4. 点「产品价格」表头也能排序（排序不是只给销量列加的）

数据通过 POST /api/products/collect-list 灌进收件箱（打开页面之后才发，
否则前端静默基线会把它们当成历史、不渲染）。
"""

import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

API = "http://127.0.0.1:8787/api"
APP = "http://127.0.0.1:5173/products"

# 名称 → 销量；故意乱序灌入，才能看出排序真的生效
ITEMS = [
    {"key": "98001", "name": "Alpha Rose", "price": "$19.98", "sales": 1200},
    {"key": "98002", "name": "Bravo Lily", "price": "$24.98", "sales": None},
    {"key": "98003", "name": "Charlie Orchid", "price": "$4.96", "sales": 3821},
    {"key": "98004", "name": "Delta Spring", "price": "$16.48", "sales": 300},
]


def post_json(url: str, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def delete_json(url: str, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="DELETE",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def column_names(page) -> list[str]:
    return page.evaluate(
        "() => [...document.querySelectorAll('.ant-table-tbody .cell-product')]"
        ".map(e => e.textContent.trim().split('\\n')[0])"
    )


def main() -> int:
    ok = True
    delete_json(f"{API}/products/collect/inbox", {"all": True})

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
        page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()
        page.goto(APP, wait_until="networkidle")
        page.wait_for_timeout(2500)  # 让静默基线落定

        post_json(f"{API}/products/collect-list", {
            "channel": "samsclub",
            "listUrl": "https://www.samsclub.com/s/flowers",
            "items": [
                {
                    "url": f"https://www.samsclub.com/ip/x/{it['key']}",
                    "title": it["name"],
                    "price": it["price"],
                    "sales": it["sales"],
                }
                for it in ITEMS
            ],
        })
        page.wait_for_timeout(6000)  # 跨过两轮轮询

        print("== 1. 销量列存在且按千分位展示 ==")
        headers = page.evaluate(
            "() => [...document.querySelectorAll('.ant-table-thead th')].map(e => e.textContent)"
        )
        print(f"   表头: {headers}")
        if not any("销量" in h for h in headers):
            ok = False
            print("   FAIL 表头里没有「销量」列")
        else:
            print("   ok   表头有「销量」列")

        cells = page.evaluate(
            "() => [...document.querySelectorAll('.ant-table-tbody .cell-sales')].map(e => e.textContent)"
        )
        print(f"   销量单元格: {cells}")
        for want in ("1,200", "3,821", "300"):
            if want not in cells:
                ok = False
                print(f"   FAIL 没找到格式化后的 {want}")

        print("== 2. 没有销量的行显示「—」而不是 0 ==")
        rows = page.evaluate(
            "() => [...document.querySelectorAll('.ant-table-tbody tr')].map(tr => tr.innerText)"
        )
        lily = next((t for t in rows if "Bravo Lily" in t), "")
        print(f"   Bravo Lily 行文本: {lily!r}")
        if "—" not in lily:
            ok = False
            print("   FAIL 无销量行没有显示 —（不能显示 0）")
        else:
            print("   ok   无销量行显示 —")

        print("== 3. 点「销量」表头排序 ==")
        sorter = page.locator(".ant-table-thead th").filter(has_text="销量").first
        sorter.click()
        page.wait_for_timeout(500)
        asc = column_names(page)
        print(f"   升序: {asc}")
        sorter.click()
        page.wait_for_timeout(500)
        desc = column_names(page)
        print(f"   降序: {desc}")

        if asc != ["Bravo Lily", "Delta Spring", "Alpha Rose", "Charlie Orchid"]:
            ok = False
            print("   FAIL 销量升序不对（期望 Bravo Lily / Delta Spring / Alpha Rose / Charlie Orchid）")
        else:
            print("   ok   销量升序正确（没有销量的排在最前）")
        if desc != ["Charlie Orchid", "Alpha Rose", "Delta Spring", "Bravo Lily"]:
            ok = False
            print("   FAIL 销量降序不对（期望 Charlie Orchid / Alpha Rose / Delta Spring / Bravo Lily）")
        else:
            print("   ok   销量降序正确")

        print("== 4. 点「产品价格」表头也能排序 ==")
        price_sorter = page.locator(".ant-table-thead th").filter(has_text="产品价格").first
        price_sorter.click()
        page.wait_for_timeout(500)
        p_asc = column_names(page)
        price_sorter.click()
        page.wait_for_timeout(500)
        p_desc = column_names(page)
        print(f"   价格升序: {p_asc}")
        print(f"   价格降序: {p_desc}")
        # 价格升序：4.96 / 16.48 / 19.98 / 24.98
        if p_asc != ["Charlie Orchid", "Delta Spring", "Alpha Rose", "Bravo Lily"]:
            ok = False
            print("   FAIL 价格升序不对")
        else:
            print("   ok   价格升序正确")
        # 价格降序：24.98 / 19.98 / 16.48 / 4.96
        if p_desc != ["Bravo Lily", "Alpha Rose", "Delta Spring", "Charlie Orchid"]:
            ok = False
            print("   FAIL 价格降序不对")
        else:
            print("   ok   价格降序正确")

        browser.close()

    delete_json(f"{API}/products/collect/inbox", {"all": True})
    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
