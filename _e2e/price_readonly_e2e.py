"""价格列验证：按采集币种把金额符号跟在数字后面 + 只读不可改。

断言：
  1. 美元商品显示 19.98$、人民币商品显示 199.00¥（符号跟着采集币种走，且在数字后面）
  2. 价格单元格里没有任何输入框（不可编辑）
  3. 没采到价格的商品显示「—」
"""

import json
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

API = "http://127.0.0.1:8787/api"
APP = "http://127.0.0.1:5173/products"


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


def main() -> int:
    ok = True
    delete_json(f"{API}/products/collect/inbox", {"all": True})

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
        page = browser.new_context().new_page()
        page.goto(APP, wait_until="networkidle")
        page.wait_for_timeout(2500)  # 让静默基线落定

        # 打开页面之后再采集，才会被前端轮询接收
        post_json(f"{API}/products/collect-list", {
            "channel": "samsclub",
            "listUrl": "https://www.samsclub.com/s/flowers",
            "items": [
                {"url": "https://www.samsclub.com/ip/rose/98001", "title": "Red Roses Bouquet, 12 Stems", "price": "$19.98"},
                {"url": "https://www.samsclub.com/ip/lily/98002", "title": "White Lily Potted Plant", "price": "¥199.00"},
                {"url": "https://www.samsclub.com/ip/orchid/98003", "title": "Phalaenopsis Orchid Pot", "price": None},
            ],
        })
        page.wait_for_timeout(6000)  # 跨过两轮轮询

        prices = page.evaluate(
            "() => [...document.querySelectorAll('.ant-table-tbody .cell-price')].map(e => e.textContent)"
        )
        print(f"价格单元格文本: {prices}")
        if "19.98$" not in prices:
            ok = False
            print("   FAIL 美元商品没有显示成 19.98$（金额符号应在数字后面）")
        if "199.00¥" not in prices:
            ok = False
            print("   FAIL 人民币商品没有显示成 199.00¥（金额符号应在数字后面）")

        inputs_in_price_cell = page.evaluate(
            "() => [...document.querySelectorAll('.ant-table-tbody .ant-table-cell')]"
            ".filter(td => td.textContent.includes('$') || td.textContent.includes('¥'))"
            ".reduce((n, td) => n + td.querySelectorAll('input').length, 0)"
        )
        print(f"价格单元格里的输入框数量: {inputs_in_price_cell}（应为 0）")
        if inputs_in_price_cell != 0:
            ok = False
            print("   FAIL 价格仍然可编辑")

        rows = page.locator(".ant-table-tbody .cell-product").count()
        print(f"商品行数: {rows}（应为 3）")
        if rows != 3:
            ok = False
            print("   FAIL 行数不对")

        # 无价格的那行应显示「—」
        no_price = page.evaluate(
            "() => [...document.querySelectorAll('.ant-table-tbody tr')].map(tr => tr.innerText)"
        )
        has_dash = any("Phalaenopsis" in t and "—" in t for t in no_price)
        print(f"无价格商品显示「—」: {has_dash}")
        if not has_dash:
            ok = False
            print("   FAIL 无价格商品没有显示 —")

        browser.close()

    delete_json(f"{API}/products/collect/inbox", {"all": True})
    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
