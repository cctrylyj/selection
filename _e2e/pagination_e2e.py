"""分页 + 导出全量验证（商品列表页）。

断言：
  1. 默认每页 10 条，表格只渲染 10 行，分页器显示「第 1-10 条 / 共 25 条」
  2. 翻到第 2 页换一批数据；每页条数切到 50 后 25 行一次显示完
  3. 跨页勾选能保留（第 1 页勾 1 个 + 第 2 页勾 1 个 = 已选 2 项）
  4. 有勾选时导出只含勾选项；清空勾选后导出的是**全部 25 条**（不受分页影响）
"""

import json
import sys
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8787/api"
APP = "http://127.0.0.1:5173/products"
OUT_DIR = ROOT / "_e2e" / "_tmp"

TOTAL = 25


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


def rows_shown(page) -> int:
    return page.locator(".ant-table-tbody .cell-product").count()


def sheet_rows(path: Path):
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(path) as z:
        xml = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    root = ET.fromstring(xml)
    rows = list(root.iter(f"{ns}row"))
    return rows[0], rows[1:]  # 表头行, 数据行


def main() -> int:
    ok = True
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    delete_json(f"{API}/products/collect/inbox", {"all": True})

    items = [
        {
            "url": f"https://www.samsclub.com/ip/item-{i}/{90000 + i}",
            "title": f"测试商品 {i:02d} Spring Bouquet",
            "price": f"${10 + i}.99",
            "sales": 100 + i,
        }
        for i in range(1, TOTAL + 1)
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()
        page.goto(APP, wait_until="networkidle")
        page.wait_for_timeout(2500)  # 静默基线

        post_json(f"{API}/products/collect-list", {
            "channel": "samsclub",
            "listUrl": "https://www.samsclub.com/s/test",
            "items": items,
        })
        page.wait_for_timeout(6000)

        print("== 1. 默认分页 ==")
        total_text = page.locator(".ant-pagination-total-text").inner_text()
        shown = rows_shown(page)
        print(f"   分页器: {total_text} | 当前页行数: {shown}")
        if shown != 10:
            ok = False
            print("   FAIL 默认每页应为 10 行")
        if "共 25 条" not in total_text:
            ok = False
            print("   FAIL 分页器总数不对")

        first_page_names = page.evaluate(
            "() => [...document.querySelectorAll('.ant-table-tbody .cell-product')].map(e => e.textContent)"
        )

        print("== 2. 翻到第 2 页 ==")
        page.locator(".ant-pagination-item-2").click()
        page.wait_for_timeout(500)
        shown2 = rows_shown(page)
        page2_names = page.evaluate(
            "() => [...document.querySelectorAll('.ant-table-tbody .cell-product')].map(e => e.textContent)"
        )
        print(f"   第 2 页行数: {shown2}")
        if shown2 != 10:
            ok = False
            print("   FAIL 第 2 页应为 10 行")
        if set(first_page_names) & set(page2_names):
            ok = False
            print("   FAIL 两页内容重复")

        print("== 3. 快速跳页 ==")
        jumper = page.locator(".ant-pagination-options-quick-jumper input")
        print(f"   跳页输入框: {jumper.count()}（应为 1）")
        if jumper.count() != 1:
            ok = False
            print("   FAIL 缺少快速跳页输入框")
        else:
            jumper.fill("3")
            jumper.press("Enter")
            page.wait_for_timeout(500)
            shown3 = rows_shown(page)
            active = page.locator(".ant-pagination-item-active").inner_text()
            print(f"   跳页后：第 {active} 页，行数 {shown3}（25 条的第 3 页应为 5 行）")
            if active.strip() != "3" or shown3 != 5:
                ok = False
                print("   FAIL 快速跳页没生效")

        print("== 4. 跨页勾选 ==")
        page.locator(".ant-pagination-item-2").click()
        page.wait_for_timeout(400)
        page.locator(".ant-table-tbody .ant-checkbox-input").first.check()
        page.wait_for_timeout(300)
        page.locator(".ant-pagination-item-1").click()
        page.wait_for_timeout(400)
        page.locator(".ant-table-tbody .ant-checkbox-input").first.check()
        page.wait_for_timeout(300)
        selected_text = page.locator(".table-toolbar .muted").inner_text()
        print(f"   {selected_text}")
        if "已选 2 项" not in selected_text:
            ok = False
            print("   FAIL 跨页勾选没有保留")

        print("== 5. 有勾选 → 只导勾选项 ==")
        with page.expect_download(timeout=30000) as dl:
            page.get_by_role("button", name="导出 Excel").click()
        picked = OUT_DIR / "pagination_selected.xlsx"
        dl.value.save_as(picked)
        _, data = sheet_rows(picked)
        print(f"   导出数据行: {len(data)}（应为 2）")
        if len(data) != 2:
            ok = False
            print("   FAIL 勾选导出条数不对")

        print("== 6. 清空勾选 → 导出全部 25 条（不受分页影响） ==")
        page.get_by_role("button", name="清空勾选").click()
        page.wait_for_timeout(400)
        with page.expect_download(timeout=30000) as dl2:
            page.get_by_role("button", name="导出 Excel").click()
        allp = OUT_DIR / "pagination_all.xlsx"
        dl2.value.save_as(allp)
        _, data2 = sheet_rows(allp)
        print(f"   导出数据行: {len(data2)}（应为 25，当前页只有 10）")
        if len(data2) != TOTAL:
            ok = False
            print("   FAIL 导出不是全量数据")

        print("== 7. 每页条数切到 50 ==")
        page.locator(".ant-pagination-options .ant-select").click()
        page.wait_for_timeout(300)
        page.get_by_title("50 条/页").click()
        page.wait_for_timeout(600)
        shown50 = rows_shown(page)
        total_text2 = page.locator(".ant-pagination-total-text").inner_text()
        print(f"   行数: {shown50} | {total_text2}")
        if shown50 != TOTAL:
            ok = False
            print("   FAIL 50 条/页 应一次显示全部 25 行")
        if "共 25 条" not in total_text2:
            ok = False
            print("   FAIL 切换每页条数后总数不对")

        print("== 8. 全选全部（跨页） ==")
        # 「全选全部」只在有多页时出现，先切回 10 条/页
        page.locator(".ant-pagination-options .ant-select").click()
        page.wait_for_timeout(300)
        page.get_by_title("10 条/页").click()
        page.wait_for_timeout(600)
        page.get_by_role("button", name="全选全部").click()
        page.wait_for_timeout(400)
        selected_all = page.locator(".table-toolbar .muted").inner_text()
        print(f"   {selected_all}（应为 25 项）")
        if "已选 25 项" not in selected_all:
            ok = False
            print("   FAIL 全选全部没有选中 25 项")
        if rows_shown(page) != 10:
            ok = False
            print("   FAIL 全选全部后当前页行数应仍为 10")

        browser.close()

    delete_json(f"{API}/products/collect/inbox", {"all": True})
    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
