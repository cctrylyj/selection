"""UI 级验证三件事：
  1. 打开页面是空的，不会自动灌入历史采集（初始化不自动采集）
  2. 打开之后新采集的商品会自动出现
  3. 批量删除按钮可用，删除后服务端同步清掉（刷新也不会回来）
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8787/api"
APP = "http://127.0.0.1:5173/products"
SEARCH_PAGE = (ROOT / "_e2e" / "fake-search-page.html").as_uri()


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


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


def row_count(page) -> int:
    """只数真实商品行：空态是 Antd 的 Empty，没有 .cell-product"""
    return page.locator(".ant-table-tbody .cell-product").count()


def main() -> int:
    ok = True

    # 清掉服务端历史，保证断言可预期
    delete_json(f"{API}/products/collect/inbox", {"all": True})

    # 预置 3 条历史采集（模拟上次会话遗留）
    post_json(f"{API}/products/collect", {
        "channel": "samsclub", "url": "https://www.samsclub.com/ip/old-1/1", "title": "历史遗留 1", "price": "9.99",
    })
    post_json(f"{API}/products/collect", {
        "channel": "samsclub", "url": "https://www.samsclub.com/ip/old-2/2", "title": "历史遗留 2", "price": "8.88",
    })
    post_json(f"{API}/products/collect", {
        "channel": "samsclub", "url": "https://www.samsclub.com/ip/old-3/3", "title": "历史遗留 3", "price": "7.77",
    })
    print("== 已预置 3 条历史采集 ==")

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
        page = browser.new_context().new_page()
        page.goto(APP, wait_until="networkidle")

        print("== 1. 打开页面，等 7 秒（跨过两轮轮询） ==")
        page.wait_for_timeout(7000)
        count = row_count(page)
        print(f"   商品行数: {count}（应为 0）")
        if count != 0:
            ok = False
            print("   FAIL 自动灌入了历史数据")

        print("== 2. 用书签采集触发一次新采集 ==")
        info = get_json(f"{API}/products/collect-info?channel=samsclub")["data"]
        script = info["bookmarklet"][len("javascript:"):]
        shop = browser.new_context().new_page()
        shop.goto(SEARCH_PAGE, wait_until="load")
        shop.evaluate(script)
        shop.wait_for_timeout(2000)
        shop.close()
        page.bring_to_front()
        page.wait_for_timeout(6000)
        names = page.evaluate(
            "() => [...document.querySelectorAll('.cell-product')].map(e => e.textContent)"
        )
        print(f"   商品行数: {len(names)}")
        if len(names) < 4:
            ok = False
            print("   FAIL 新采集没有自动出现")

        print("== 3. 全选 + 批量删除 ==")
        before_server = len(get_json(f"{API}/products/collect/pending")["data"]["items"])
        shown = row_count(page)
        page.get_by_role("checkbox", name="全选").check()
        page.wait_for_timeout(300)
        page.locator("button:has-text('批量删除')").click()
        page.wait_for_timeout(500)
        # Popconfirm 浮层里的确认按钮
        page.locator(".ant-popover .ant-btn-primary").first.click()
        page.wait_for_timeout(1500)
        left = row_count(page)
        server_left = len(get_json(f"{API}/products/collect/pending")["data"]["items"])
        print(f"   删除前服务端 {before_server} 项、表格 {shown} 行 → 删除后表格 {left} 行，服务端剩余 {server_left}")
        if left != 0 or server_left != before_server - shown:
            ok = False
            print("   FAIL 删除不同步")
        browser.close()

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
