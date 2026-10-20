"""Excel 导出验证（商品列表页）。

断言：
  1. 「导出 Excel」按钮存在，未勾选时导出全部行（3 条）
  2. 导出的文件是合法 xlsx：sheet 名、表头、行数、价格/销量是数字、缺价留空
  3. 商品图是**真正嵌入**的图片（xl/media + drawing 锚点），不是图片链接
  4. 勾选 1 行后按钮文案变成「导出 Excel（已选 1）」，导出只包含勾选那 1 行
  5. 导出后服务端数据不受影响（导出是只读操作）

图片链路说明：CDN 图没有 CORS 头，前端走 /api/proxy/image 由服务端代取。
这里为了不依赖外网，本地起一个 127.0.0.1 的图片服务当「CDN」，
后端需以 ALLOW_LOCAL_IMAGE_PROXY=1 启动（见 run 脚本注释）。
"""

import json
import struct
import sys
import threading
import urllib.request
import zipfile
import zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8787/api"
APP = "http://127.0.0.1:5173/products"
OUT_DIR = ROOT / "_e2e" / "_tmp"
IMG_DIR = OUT_DIR / "images"
IMG_PORT = 8799

HEADERS = ["渠道", "产品名称", "产品类目", "产品价格", "币种", "销量/评价数", "商品链接", "图片"]


def make_png(path: Path, size: int, rgb) -> None:
    """不依赖 Pillow，手写一张纯色 PNG 当商品图"""
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def start_image_server():
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    handler = partial(SimpleHTTPRequestHandler, directory=str(IMG_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", IMG_PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


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


def check_embedded_images(path: Path, expect: int, label: str) -> bool:
    """确认图是真嵌进去的：media 二进制 + drawing 锚点 + sheet 里的 drawing 引用"""
    ok = True
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        media = sorted(n for n in names if n.startswith("xl/media/"))
        print(f"   [{label}] 媒体文件: {media}（应为 {expect} 张）")
        if len(media) != expect:
            ok = False
            print(f"   FAIL 嵌入图片数量 {len(media)} != {expect}")

        # 每张都必须是浏览器转码后的 JPEG（Excel 不认 webp）
        for n in media:
            head = z.read(n)[:3]
            if head != b"\xff\xd8\xff":
                ok = False
                print(f"   FAIL {n} 不是 JPEG（前 3 字节 {head!r}）")

        sheet = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
        if '<drawing r:id="rId1"/>' not in sheet:
            ok = False
            print("   FAIL sheet1.xml 没有引用 drawing")
        if 'ht="60" customHeight="1"' not in sheet:
            ok = False
            print("   FAIL 有图的行没有加高（图会被裁切）")

        ct = z.read("[Content_Types].xml").decode("utf-8")
        if 'Extension="jpeg"' not in ct or "/xl/drawings/drawing1.xml" not in ct:
            ok = False
            print("   FAIL [Content_Types].xml 缺图片/drawing 声明")

        if "xl/drawings/drawing1.xml" not in names:
            ok = False
            print("   FAIL 缺 xl/drawings/drawing1.xml")
            return ok

        drawing = z.read("xl/drawings/drawing1.xml").decode("utf-8")
        anchors = drawing.count("<xdr:oneCellAnchor>")
        print(f"   [{label}] drawing 锚点数: {anchors}（应为 {expect}）")
        if anchors != expect:
            ok = False
            print("   FAIL 锚点数量不对")
        # 第 1 条数据（表头是第 0 行）应锚在第 1 行第 7 列（H 列）
        if "<xdr:col>7</xdr:col>" not in drawing or "<xdr:row>1</xdr:row>" not in drawing:
            ok = False
            print("   FAIL 图片没有锚在「图片」列的数据行上")
        if 'r:embed="rId1"' not in drawing:
            ok = False
            print("   FAIL drawing 没有引用图片关系")

        rels = z.read("xl/drawings/_rels/drawing1.xml.rels").decode("utf-8")
        if "../media/image1.jpeg" not in rels:
            ok = False
            print("   FAIL drawing rels 没有指向 media/image1.jpeg")
    return ok


def main() -> int:
    ok = True
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    make_png(IMG_DIR / "rose.png", 200, (200, 40, 40))
    make_png(IMG_DIR / "lily.png", 160, (240, 240, 240))
    server = start_image_server()
    print(f"== 本地图片服务已启动: http://127.0.0.1:{IMG_PORT} ==")

    items = [
        {"url": "https://www.samsclub.com/ip/rose/98001", "title": "Red Roses Bouquet, 12 Stems",
         "price": "$19.98", "sales": 6754, "image": f"http://127.0.0.1:{IMG_PORT}/rose.png"},
        {"url": "https://www.samsclub.com/ip/lily/98002", "title": "White Lily Potted Plant",
         "price": "¥199.00", "sales": 1234, "image": f"http://127.0.0.1:{IMG_PORT}/lily.png"},
        {"url": "https://www.samsclub.com/ip/orchid/98003", "title": "Phalaenopsis Orchid Pot",
         "price": None, "sales": None, "image": ""},
    ]

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
            "items": items,
        })
        page.wait_for_timeout(6000)

        btn = page.get_by_role("button", name="导出 Excel")
        if btn.count() != 1:
            print(f"   FAIL 找不到「导出 Excel」按钮（匹配到 {btn.count()} 个）")
            browser.close()
            server.shutdown()
            return 1
        print(f"== 1. 按钮文案: {btn.inner_text().strip()} ==")

        print("== 2. 未勾选 → 导出全部（含 2 张图） ==")
        with page.expect_download(timeout=30000) as dl:
            btn.click()
        all_path = OUT_DIR / "export_all.xlsx"
        dl.value.save_as(all_path)
        print(f"   下载文件名: {dl.value.suggested_filename}")
        ok = check_file(all_path, 3, "全部") and ok
        ok = check_embedded_images(all_path, 2, "全部") and ok

        _, rows = read_sheet(all_path)
        body = rows[1:]
        prices = [r.get("D") for r in body]
        sales = [r.get("F") for r in body]
        currencies = [r.get("E") for r in body]
        names = [r.get("B") for r in body]
        print(f"   价格列: {prices}（应为 19.98 / 199 / None）")
        print(f"   币种列: {currencies}（应为 USD / CNY / USD）")
        print(f"   销量列: {sales}（应为 6754 / 1234 / None）")
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

        print("== 3. 勾选第 1 行 → 只导勾选项（1 张图） ==")
        page.locator(".ant-table-tbody .ant-checkbox-input").first.check()
        page.wait_for_timeout(400)
        label = page.get_by_role("button", name="导出 Excel").inner_text().strip()
        print(f"   按钮文案: {label}（应含「已选 1」）")
        if "已选 1" not in label:
            ok = False
            print("   FAIL 按钮文案没有跟随勾选数变化")
        with page.expect_download(timeout=30000) as dl2:
            page.get_by_role("button", name="导出 Excel").click()
        one_path = OUT_DIR / "export_one.xlsx"
        dl2.value.save_as(one_path)
        ok = check_file(one_path, 1, "勾选") and ok
        ok = check_embedded_images(one_path, 1, "勾选") and ok
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

    server.shutdown()
    delete_json(f"{API}/products/collect/inbox", {"all": True})
    print("\n结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
