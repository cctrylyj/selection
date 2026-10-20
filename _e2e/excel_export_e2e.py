"""Excel 导出验证（商品列表页）。

断言：
  1. 「导出 Excel」按钮存在，未勾选时导出全部行（3 条）
  2. 导出的文件是合法 xlsx：sheet 名、表头、行数、价格/销量是数字、缺价留空
  3. 勾选 1 行后按钮文案变成「导出 Excel（已选 1）」，导出只包含勾选那 1 行
  4. 导出后服务端数据不受影响（导出是只读操作）
"""

import json
import sys
import urllib.request
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8787/api"
APP = "http://127.0.0.1:5173/products"
OUT_DIR = ROOT / "_e2e" / "_tmp"

HEADERS = ["渠道", "产品名称", "产品类目", "产品价格", "币种", "销量/评价数", "商品链接", "图片链接"]

ITEMS = [
    {"url": "https://www.samsclub.com/ip/rose/98001", "title": "Red Roses Bouquet, 12 Stems",
     "price": "$19.98", "sales": 6754},
    {"url": "https://www.samsclub.com/ip/lily/98002", "title": "White Lily Potted Plant",
     "price": "¥199.00", "sales": 1234},
    {"url": "https://www.samsclub.com/ip/orchid/98003", "title": "Phalaenopsis Orchid Pot",
     "price": None, "sales": None},
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


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def read_sheet(path: Path):
    """直接解析 xlsx（zip + XML），不依赖 openpyxl：确认文件本身是标准格式"""
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad is not None:
            raise AssertionError(f"zip 损坏：{bad}")
        wb = z.read("xl/workbook.xml").decode("utf-8")
        sheet_name = wb.split('name="', 1)[1].split('"', 1)[0]
        xml = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml)
    rows = []
    for row in root.iter(f"{ns}row"):
        cells = {}
        for c in row.findall(f"{ns}c"):
            ref = c.get("r")
            col = "".join(ch for ch in ref if ch.isalpha())
            t = c.get("t")
            if t == "inlineStr":
                node = c.find(f"{ns}is/{ns}t")
                cells[col] = node.text if node is not None else ""
            else:
                v = c.find(f"{ns}v")
                raw = v.text if v is not None else None
                if raw is None:
                    cells[col] = None
                else:
                    cells[col] = float(raw) if ("." in raw) else int(raw)
        rows.append(cells)
    return sheet_name, rows


def check_file(path: Path, expect_rows: int, label: str) -> bool:
    ok = True
    sheet, rows = read_sheet(path)
    header = [rows[0].get(c) for c in "ABCDEFGH"]
    body = rows[1:]
    print(f"   [{label}] sheet={sheet} 行数={len(body)}（应为 {expect_rows}）")
    print(f"   [{label}] 表头={header}")
    if sheet != "商品列表":
        ok = False
        print(f"   FAIL sheet 名不是「商品列表」，实际 {sheet}")
    if header != HEADERS:
        ok = False
        print(f"   FAIL 表头不符，期望 {HEADERS}")
    if len(body) != expect_rows:
        ok = False
        print(f"   FAIL 数据行数 {len(body)} != {expect_rows}")
    return ok


def main() -> int:
    ok = True
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    delete_json(f"{API}/products/collect/inbox", {"all": True})

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()
        page.goto(APP, wait_until="networkidle")
        page.wait_for_timeout(2500)  # 让静默基线落定

        post_json(f"{API}/products/collect-list", {
            "channel": "samsclub",
            "listUrl": "https://www.samsclub.com/s/flowers",
            "items": ITEMS,
        })
        page.wait_for_timeout(6000)

        btn = page.get_by_role("button", name="导出 Excel")
        if btn.count() != 1:
            print(f"   FAIL 找不到「导出 Excel」按钮（匹配到 {btn.count()} 个）")
            browser.close()
            return 1
        print(f"== 1. 按钮文案: {btn.inner_text().strip()} ==")

        print("== 2. 未勾选 → 导出全部 ==")
        with page.expect_download(timeout=15000) as dl:
            btn.click()
        all_path = OUT_DIR / "export_all.xlsx"
        dl.value.save_as(all_path)
        print(f"   下载文件名: {dl.value.suggested_filename}")
        ok = check_file(all_path, 3, "全部") and ok

        _, rows = read_sheet(all_path)
        body = rows[1:]
        prices = [r.get("D") for r in body]
        sales = [r.get("F") for r in body]
        currencies = [r.get("E") for r in body]
        names = [r.get("B") for r in body]
        print(f"   价格列: {prices}（应为 19.98 / 199 / None）")
        print(f"   币种列: {currencies}（应为 USD / CNY / USD）")
        print(f"   销量列: {sales}（应为 6754 / 1234 / None）")
        print(f"   名称列: {names}")
        if prices != [19.98, 199, None]:
            ok = False
            print("   FAIL 价格不是数值或缺失值没有留空")
        if currencies != ["USD", "CNY", "USD"]:
            ok = False
            print("   FAIL 币种列不对")
        if sales != [6754, 1234, None]:
            ok = False
            print("   FAIL 销量列不是整数或缺失值没有留空")
        if not any("Red Roses" in str(n) for n in names):
            ok = False
            print("   FAIL 产品名称缺失")

        print("== 3. 勾选第 1 行 → 只导勾选项 ==")
        page.locator(".ant-table-tbody .ant-checkbox-input").first.check()
        page.wait_for_timeout(400)
        label = page.get_by_role("button", name="导出 Excel").inner_text().strip()
        print(f"   按钮文案: {label}（应含「已选 1」）")
        if "已选 1" not in label:
            ok = False
            print("   FAIL 按钮文案没有跟随勾选数变化")
        with page.expect_download(timeout=15000) as dl2:
            page.get_by_role("button", name="导出 Excel").click()
        one_path = OUT_DIR / "export_one.xlsx"
        dl2.value.save_as(one_path)
        ok = check_file(one_path, 1, "勾选") and ok
        _, rows2 = read_sheet(one_path)
        picked = rows2[1].get("B")
        print(f"   导出内容: {picked}（应为 Red Roses Bouquet, 12 Stems）")
        if "Red Roses" not in str(picked):
            ok = False
            print("   FAIL 导出的不是勾选那一行")

        print("== 4. 导出不应影响服务端数据 ==")
        left = len(get_json(f"{API}/products/collect/pending")["data"]["items"])
        print(f"   服务端剩余 {left} 项（应为 3）")
        if left != 3:
            ok = False
            print("   FAIL 导出改动了服务端数据")

        browser.close()

    delete_json(f"{API}/products/collect/inbox", {"all": True})
    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
