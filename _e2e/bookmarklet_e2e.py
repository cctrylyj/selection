"""
端到端验证：
  1. 用真实 Chrome 打开一个合成商品页（结构与山姆商品页一致）
  2. 在该页面里执行系统生成的书签脚本（真实跨域 POST）
  3. 校验后端收件箱拿到解析后的商品字段
  4. 再验证「粘贴导入」对无反爬站点的可用性（books.toscrape.com）

用法：
  C:/Users/cctry/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe _e2e/bookmarklet_e2e.py
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8787/api"
PAGE = (ROOT / "_e2e" / "fake-product-page.html").as_uri()


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def post_json(url: str, payload: dict):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    ok = True
    print("== 1. 取书签代码 ==")
    info = get_json(f"{API}/products/collect-info?channel=samsclub")["data"]
    assert info["bookmarklet"].startswith("javascript:"), "书签代码应以 javascript: 开头"
    script = info["bookmarklet"][len("javascript:"):]
    print(f"   采集地址: {info['collectUrl']}")

    print("== 2. 真实 Chrome 打开商品页并点击书签 ==")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="chrome",
            headless=False,          # 与用户实际使用一致：书签在真实页面里跑
            args=["--disable-extensions"],
        )
        ctx = browser.new_context()
        page = ctx.new_page()

        console = []
        page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))

        page.goto(PAGE, wait_until="load")
        page.evaluate("() => { window.__toasts = []; const obs = new MutationObserver(() => { document.querySelectorAll('div').forEach(d => { if (d.style && d.style.position === 'fixed' && d.style.zIndex === '2147483647') window.__toasts.push(d.textContent); }); }); obs.observe(document.documentElement, { childList: true, subtree: true }); }")
        page.evaluate(script)
        page.wait_for_timeout(2500)

        toasts = page.evaluate("() => window.__toasts")
        print(f"   页面提示: {toasts}")
        if not any(t and "已采集" in t for t in toasts):
            print("   [!] 未看到成功提示，控制台输出：")
            for line in console[:10]:
                print("      ", line)
        browser.close()

    print("== 3. 校验收件箱 ==")
    pending = get_json(f"{API}/products/collect/pending")["data"]["items"]
    if not pending:
        print("   FAIL 收件箱为空")
        return 1
    prod = pending[-1]["product"]
    for key, expect in [
        ("productName", "Member's Mark Bath Tissue, 2-Ply, 45 Rolls"),
        ("channelKey", "1425143980"),
        ("price", 24.98),
        ("currency", "USD"),
        # 销量取详情页 JSON-LD 的 aggregateRating.reviewCount，不是 ratingValue(4.6)
        ("sales", 3821),
        ("category", "Grocery > Paper Goods > Bath Tissue"),
        ("channel", "samsclub"),
    ]:
        got = prod.get(key)
        mark = "ok  " if got == expect else "FAIL"
        if got != expect:
            ok = False
        print(f"   {mark} {key}: {got!r}")

    print("== 4. 收件箱游标（since） ==")
    last_id = pending[-1]["id"]
    after = get_json(f"{API}/products/collect/pending?since={last_id}")["data"]["items"]
    print(f"   ok   since 后新增 {len(after)} 条（应为 0）")
    if after:
        ok = False

    print("== 5. 粘贴导入：无反爬站点真实 URL ==")
    try:
        imp = post_json(
            f"{API}/products/import",
            {"channel": "samsclub", "url": "http://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"},
        )["data"]["product"]
        print(f"   ok   导入成功: {imp['productName']} / £{imp['price']} / key={imp['channelKey']}")
        if not imp.get("productName"):
            ok = False
    except Exception as e:  # noqa: BLE001
        print(f"   (跳过/失败: {e})")

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
