"""验证「不做去重」：同一条商品采两次，服务端与表格都要有两条。

断言：
  1. 一批里含两个完全相同的 URL → count=3 / inserted=3 / skipped=0（不再被当重复丢掉）
  2. 服务端收件箱确实存了 3 条
  3. 前端表格渲染 3 行，且同一个商品名出现两次（行标识不冲突）
"""

import json
import sys
import urllib.request

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


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def delete_json(url: str, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="DELETE",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


SAME = {
    "url": "https://www.samsclub.com/ip/red-roses/98001",
    "title": "Red Roses Bouquet, 12 Stems",
    "price": "$19.98",
}


def main() -> int:
    ok = True
    delete_json(f"{API}/products/collect/inbox", {"all": True})

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
        page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
        page.goto(APP, wait_until="networkidle")
        page.wait_for_timeout(2500)  # 静默基线落定

        # 同一批里塞两条完全相同的商品，外加一条不同的
        res = post_json(f"{API}/products/collect-list", {
            "channel": "samsclub",
            "listUrl": "https://www.samsclub.com/s/flowers",
            "items": [SAME, dict(SAME), {
                "url": "https://www.samsclub.com/ip/white-lily/98002",
                "title": "White Lily Potted Plant",
                "price": "$24.98",
            }],
        })["data"]
        print(f"服务端返回: count={res['count']} inserted={res['inserted']} skipped={res['skipped']}")
        if res["count"] != 3 or res["inserted"] != 3 or res["skipped"] != 0:
            ok = False
            print("   FAIL 重复商品被丢掉了")

        stored = get_json(f"{API}/products/collect/pending")["data"]["items"]
        print(f"收件箱条数: {len(stored)}（应为 3）")
        if len(stored) != 3:
            ok = False
            print("   FAIL 收件箱没有存满 3 条")

        page.wait_for_timeout(6000)  # 跨过两轮轮询
        names = page.evaluate(
            "() => [...document.querySelectorAll('.ant-table-tbody .cell-product')].map(e => e.textContent)"
        )
        print(f"表格行数: {len(names)}（应为 3）")
        if len(names) != 3:
            ok = False
            print("   FAIL 表格行数不对（可能前端又把重复行合并了）")
        dup_count = sum(1 for n in names if "Red Roses" in n)
        print(f"「Red Roses Bouquet」出现次数: {dup_count}（应为 2）")
        if dup_count != 2:
            ok = False
            print("   FAIL 前端仍在去重")

        # 重复行不能共用行标识，否则勾选会互相影响
        keys = page.evaluate(
            "() => [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')]"
            ".map(tr => tr.getAttribute('data-row-key'))"
        )
        print(f"行标识: {keys}；去重后 {len(set(keys))} 个（应等于行数）")
        if len(set(keys)) != len(keys):
            ok = False
            print("   FAIL 存在重复行标识")

        browser.close()

    delete_json(f"{API}/products/collect/inbox", {"all": True})
    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
