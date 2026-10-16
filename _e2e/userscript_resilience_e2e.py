"""用户脚本「装了却看不到按钮」的针对性验证。

覆盖三件事：
  1. 元数据：必须是 @grant unsafeWindow（不能是 @grant none，否则山姆这类
     带 CSP 的站点会静默拦截），@run-at document-start，@updateURL 已填充
  2. 语法：服务端产出的脚本必须能被 JS 引擎解析（占位符替换不能破坏代码）
  3. 抗 SPA 重渲染：按钮被页面重渲染删掉后，脚本要能自己补挂回来
  4. 快捷键兜底：Ctrl+Shift+Z 也能触发采集
"""

import json
import subprocess
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8787/api"
SEARCH_PAGE = (ROOT / "_e2e" / "fake-search-page.html").as_uri()


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    ok = True

    with urllib.request.urlopen(f"{API}/products/collector-script?channel=samsclub", timeout=15) as r:
        script = r.read().decode("utf-8")

    print("== 1. 元数据 ==")
    checks = {
        "@grant unsafeWindow": "@grant        unsafeWindow" in script,
        "不是 @grant none": "@grant        none" not in script,
        "@run-at document-start": "@run-at       document-start" in script,
        "@version 1.2.0": "@version      1.2.0" in script,
        "@updateURL 已填充": "@updateURL" in script and "__UPDATE__" not in script,
        "无占位符残留": all(p not in script for p in ("__BASE__", "__CHANNEL__", "__UPDATE__", "__PRICE_HELPER__")),
        "BASE 指向本机": "127.0.0.1:8787/api/products/collect" in script,
        "带诊断日志": "[选品采集器] v" in script,
        "标题标记（不开 F12 也能判断是否执行）": "TITLE_TAG" in script,
        "抗重渲染补挂": "MutationObserver" in script,
        "快捷键兜底": "Ctrl+Shift+Z" in script,
        "已注入拆分价格解析": "function priceFromCard" in script and "function joinSplitPrice" in script,
        "已注入销量解析": "function salesFromCard" in script and "function countOf" in script,
        "价格解析没有被 $ 替换序列改坏": r"[\s$¥€£]*[\d.,]+[\s$¥€£]*$" in script,
    }
    for k, v in checks.items():
        print(f"   {'ok  ' if v else 'FAIL'} {k}")
        if not v:
            ok = False

    print("== 2. 语法检查 ==")
    tmp = ROOT / "_e2e" / "_syntax_check.user.js"
    tmp.write_text(script, encoding="utf-8")
    res = subprocess.run(["node", "--check", str(tmp)], capture_output=True, text=True)
    print(f"   {'ok  ' if res.returncode == 0 else 'FAIL'} node --check 退出码 {res.returncode}")
    if res.returncode != 0:
        ok = False
        print("   ", res.stderr.strip()[:400])
    tmp.unlink(missing_ok=True)

    print("== 3. 抗 SPA 重渲染（删掉按钮后应自动补回） ==")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
        page = browser.new_context().new_page()
        logs: list[str] = []
        page.on("console", lambda m: logs.append(m.text))
        page.goto(SEARCH_PAGE, wait_until="load")
        page.add_script_tag(content=script)
        page.wait_for_timeout(600)

        if page.locator("#sourcing-collector-btn").count() == 0:
            print("   FAIL 初始挂载失败")
            ok = False
        else:
            print("   ok   初始已挂载")

        title = page.title()
        print(f"   标签页标题: {title}")
        if not title.startswith("【采集器"):
            ok = False
            print("   FAIL 标题没有出现「采集器」标记（用户无法自查脚本是否执行）")
        else:
            print("   ok   标题已打上采集器标记")

        # 模拟 React 重渲染把我们的按钮整个抹掉
        page.evaluate("() => { const b = document.getElementById('sourcing-collector-btn'); if (b) b.remove(); }")
        gone = page.locator("#sourcing-collector-btn").count()
        print(f"   已手动移除，当前存在数 = {gone}（应为 0）")
        page.wait_for_timeout(2200)  # 等 MutationObserver / 定时补挂
        back = page.locator("#sourcing-collector-btn").count()
        print(f"   等待 2.2s 后存在数 = {back}（应为 1）")
        if back != 1:
            ok = False
            print("   FAIL 按钮没有被自动补挂回来")

        print("== 4. 快捷键 Ctrl+Shift+Z 兜底 ==")
        before = {x["id"] for x in get_json(f"{API}/products/collect/pending")["data"]["items"]}
        page.keyboard.press("Control+Shift+Z")
        # 等成功提示出现再断言，避免把「请求还在路上」误判成「没触发」
        try:
            page.wait_for_function(
                "() => [...document.querySelectorAll('div')].some(d => "
                "d.style && d.style.position === 'fixed' && (d.textContent || '').includes('已采集'))",
                timeout=12000,
            )
            toast = page.evaluate(
                "() => [...document.querySelectorAll('div')].filter(d => d.style && "
                "d.style.position === 'fixed').map(d => d.textContent).join(' | ')"
            )
            print(f"   成功提示: {toast}")
        except Exception as e:
            print(f"   FAIL 12 秒内没有等到成功提示: {type(e).__name__}")
            ok = False
        page.wait_for_timeout(600)
        after = get_json(f"{API}/products/collect/pending")["data"]["items"]
        fresh = [x for x in after if x["id"] not in before]
        print(f"   快捷键新增采集 {len(fresh)} 条（应 >= 3）")
        if len(fresh) < 3:
            ok = False
            print("   FAIL 快捷键没有触发采集")

        print("== 5. 拆分价格（大字整数 + 小字角分） ==")
        prices = {x["product"]["channelKey"]: x["product"]["price"] for x in fresh}
        for key, expect in [
            ("98001111", 19.98),   # $ + 19 + 98 三个节点
            ("98002222", 24.98),   # 单节点 $24.98
            ("98003333", None),    # 页面没暴露价格
            ("98004444", 16.48),   # 整数节点自带 $（$16）+ 48
        ]:
            got = prices.get(key)
            mark = "ok  " if got == expect else "FAIL"
            if got != expect:
                ok = False
            print(f"   {mark} {key}: price={got}（应为 {expect}）")

        print("== 6. 销量（星级右边的数字） ==")
        sales = {x["product"]["channelKey"]: x["product"].get("sales") for x in fresh}
        for key, expect in [
            ("98001111", 6754),   # 星级容器里的裸数字；同卡片 starting-price 的 12/34 不能混进来
            ("98002222", 1234),   # aria-label "1,234 ratings"
            ("98003333", None),   # 只有星级 4.6，没有评价数 → 不能读成 5
            ("98004444", 1200),   # "1.2K sold"
        ]:
            got = sales.get(key)
            mark = "ok  " if got == expect else "FAIL"
            if got != expect:
                ok = False
            print(f"   {mark} {key}: sales={got}（应为 {expect}）")

        print("   控制台日志:")
        for line in logs[:6]:
            print("     ", line)
        if not any("[选品采集器]" in x for x in logs):
            ok = False
            print("   FAIL 没有看到脚本的诊断日志（用户将无法自查）")
        browser.close()

    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
