"""Excel 导出验证（商品列表页）。

断言：
  1. 「导出 Excel」按钮存在，未勾选时导出全部行（3 条）
  2. 导出的文件是合法 xlsx：sheet 名、表头、行数、价格/销量是数字、缺价留空
  3. 商品图是**真正嵌入**的图片（xl/media + drawing 锚点），不是图片链接
     且尺寸为 200×200（用户 2026-10-20 要求，原来 72）
  4. 价格带币种单位（19.98$ / 199.00¥），通过自定义数字格式实现——
     单元格仍是数值，不变成文本，排序求和不受影响
  5. 没有「币种」列、没有「商品链接」列（2026-10-20 要求去掉）
  6. 勾选 1 行后按钮文案变成「导出 Excel（已选 1）」，导出只包含勾选那 1 行
  7. 导出后服务端数据不受影响（导出是只读操作）

图片链路说明：CDN 图没有 CORS 头，前端走 /api/proxy/image 由服务端代取。
这里为了不依赖外网，本地起一个 127.0.0.1 的图片服务当「CDN」，
后端需以 ALLOW_LOCAL_IMAGE_PROXY=1 启动（见 run 脚本注释）。
"""

import json
import re
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

# 去掉币种列与商品链接列后的表头（6 列）
HEADERS = ["渠道", "产品名称", "产品类目", "产品价格", "销量/评价数", "图片"]
# 图片现在落在第 6 列（F，0-based 5）
IMAGE_COL_IDX = 5
IMAGE_COL_LETTER = "F"
THUMB_PX = 200


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
    """直接解析 xlsx（zip + XML），不依赖 openpyxl：确认文件本身是标准格式。

    返回 (sheet_name, rows, styles)，其中 styles 是每行每列的 `s=` 样式索引，
    用来核对「价格列用了自定义数字格式」而不只是看数值对不对。
    """
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
    styles = []
    for row in root.iter(f"{ns}row"):
        cells = {}
        cell_styles = {}
        for c in row.findall(f"{ns}c"):
            ref = c.get("r")
            col = "".join(ch for ch in ref if ch.isalpha())
            cell_styles[col] = int(c.get("s") or 0)
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
        styles.append(cell_styles)
    return sheet_name, rows, styles


def read_styles(path: Path):
    """解析 styles.xml，返回每个样式索引的完整信息：

    {index: {"numFmt": formatCode|None, "color": "FFD4380D"|None, "bold": bool,
             "horizontal": "center"|None, "fill": "FFxxxxxx"|None}}

    用来核对「价格/销量是否居中 + 是否上色」，光看数值是看不出来的。
    """
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(path) as z:
        xml = z.read("xl/styles.xml").decode("utf-8")
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml)

    numfmts = {int(nf.get("numFmtId")): nf.get("formatCode") for nf in root.iter(f"{ns}numFmt")}

    # 字体：fontId → (颜色, 是否加粗)
    fonts = []
    fonts_node = root.find(f"{ns}fonts")
    if fonts_node is not None:
        for f in fonts_node.findall(f"{ns}font"):
            c = f.find(f"{ns}color")
            color = c.get("rgb") if c is not None else None
            fonts.append({"color": color, "bold": f.find(f"{ns}b") is not None})

    # 填充：fillId → 前景色
    fills = []
    fills_node = root.find(f"{ns}fills")
    if fills_node is not None:
        for fl in fills_node.findall(f"{ns}fill"):
            fg = fl.find(f"{ns}patternFill/{ns}fgColor")
            fills.append(fg.get("rgb") if fg is not None else None)

    out = {}
    xfs = root.find(f"{ns}cellXfs")
    if xfs is not None:
        for i, xf in enumerate(xfs.findall(f"{ns}xf")):
            fid = int(xf.get("numFmtId") or 0)
            font_id = int(xf.get("fontId") or 0)
            fill_id = int(xf.get("fillId") or 0)
            align = xf.find(f"{ns}alignment")
            out[i] = {
                "numFmt": numfmts.get(fid),
                "color": fonts[font_id]["color"] if font_id < len(fonts) else None,
                "bold": fonts[font_id]["bold"] if font_id < len(fonts) else False,
                "horizontal": align.get("horizontal") if align is not None else None,
                "fill": fills[fill_id] if fill_id < len(fills) else None,
            }
    return out


def check_numfmt(path: Path):
    """兼容旧调用：只要 {style_index: formatCode} 的映射"""
    styles = read_styles(path)
    return {i: v["numFmt"] for i, v in styles.items() if v["numFmt"]}


def check_file(path: Path, expect_rows: int, label: str) -> bool:
    ok = True
    sheet, rows, _ = read_sheet(path)
    header = [rows[0].get(c) for c in "ABCDEF"]
    body = rows[1:]
    print(f"   [{label}] sheet={sheet} 行数={len(body)}（应为 {expect_rows}）")
    print(f"   [{label}] 表头={header}")
    if sheet != "商品列表":
        ok = False
        print(f"   FAIL sheet 名不是「商品列表」，实际 {sheet}")
    if header != HEADERS:
        ok = False
        print(f"   FAIL 表头不符，期望 {HEADERS}")
    if "币种" in [h for h in header if h]:
        ok = False
        print("   FAIL 「币种」列没有被去掉")
    if "商品链接" in [h for h in header if h]:
        ok = False
        print("   FAIL 「商品链接」列没有被去掉")
    # 表头后面不应再有第 7 列内容
    if rows[0].get("G"):
        ok = False
        print(f"   FAIL 表头多出第 7 列：{rows[0].get('G')!r}")
    if len(body) != expect_rows:
        ok = False
        print(f"   FAIL 数据行数 {len(body)} != {expect_rows}")
    return ok


def check_price_format(path: Path, label: str) -> bool:
    """价格带单位且仍是数值：看样式索引对应的 formatCode。"""
    ok = True
    _, rows, styles = read_sheet(path)
    style_map = read_styles(path)
    code_map = {i: v["numFmt"] for i, v in style_map.items() if v["numFmt"]}
    print(f"   [{label}] 自定义数字格式: {code_map}")
    body_vals = [(r.get("D"), styles[i + 1].get("D")) for i, r in enumerate(rows[1:])]
    for val, style in body_vals:
        if val is None:
            continue  # 无价格的单元格不加格式，正确
        fmt = code_map.get(style or 0)
        if not fmt or '0.00"' not in fmt:
            ok = False
            print(f"   FAIL 价格 {val} 没有带单位的数字格式（style={style} fmt={fmt!r}）")
        else:
            print(f"   ok   价格 {val} → 显示格式 {fmt}")
    # 价格必须还是数值，不能退化成文本
    for r in rows[1:]:
        v = r.get("D")
        if v is not None and not isinstance(v, (int, float)):
            ok = False
            print(f"   FAIL 价格变成了文本 {v!r}（会失去排序/求和能力）")
    return ok


def check_align_and_color(path: Path, label: str) -> bool:
    """价格 / 销量必须水平居中且上了色（Excel 默认数字右对齐、字体黑）。"""
    ok = True
    _, rows, styles = read_sheet(path)
    style_map = read_styles(path)

    # 列位置：D = 产品价格，E = 销量/评价数
    expect = {
        "D": ("产品价格", "FFD4380D"),
        "E": ("销量", "FF1677FF"),
    }
    for col, (name, want_color) in expect.items():
        # 取第一条有值的行来核对（缺价行没有样式）
        picked = None
        for i, r in enumerate(rows[1:]):
            if r.get(col) is not None:
                picked = (r.get(col), styles[i + 1].get(col))
                break
        if picked is None:
            ok = False
            print(f"   FAIL {name} 列没有可核对的有值单元格")
            continue

        val, style = picked
        info = style_map.get(style or 0, {})
        horizontal = info.get("horizontal")
        color = info.get("color")
        bold = info.get("bold")

        good_align = horizontal == "center"
        good_color = (color or "").upper() == want_color
        print(f"   [{label}] {name} 值={val} 水平对齐={horizontal} 颜色={color} 加粗={bold}")
        if not good_align:
            ok = False
            print(f"   FAIL {name} 没有水平居中（实际 {horizontal!r}，Excel 数字默认右对齐）")
        if not good_color:
            ok = False
            print(f"   FAIL {name} 颜色不对（实际 {color!r}，期望 {want_color}）")
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
        # 200px 图需要约 156 磅行高，否则会被裁切
        if 'ht="156" customHeight="1"' not in sheet:
            ok = False
            print("   FAIL 有图的行高不是 156 磅（200px 的图会被裁切）")

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

        # 图片落在第 6 列（F，0-based 5）、第 1 条数据在行 1
        col_ok = f"<xdr:col>{IMAGE_COL_IDX}</xdr:col>" in drawing
        print(f"   [{label}] 图片锚在列 {IMAGE_COL_IDX}（{IMAGE_COL_LETTER}）：{col_ok}")
        if not col_ok or "<xdr:row>1</xdr:row>" not in drawing:
            ok = False
            print("   FAIL 图片没有锚在「图片」列的数据行上")

        # 尺寸必须是 200×200（EMU = px × 9525）
        want_cx = THUMB_PX * 9525
        exts = re.findall(r'<xdr:ext cx="(\d+)" cy="(\d+)"/>', drawing)
        print(f"   [{label}] 图片显示尺寸(EMU): {exts[:2]}（应为 {want_cx}）")
        if not exts:
            ok = False
            print("   FAIL drawing 里没有 ext 尺寸节点")
        for cx, cy in exts:
            if int(cx) != want_cx or int(cy) != want_cx:
                ok = False
                print(f"   FAIL 图片尺寸 {cx}x{cy} EMU 不是 {THUMB_PX}×{THUMB_PX}px")
                break

        if 'r:embed="rId1"' not in drawing:
            ok = False
            print("   FAIL drawing 没有引用图片关系")

        # 嵌入的 JPEG 实际像素也必须接近 200（不能只是显示放大）
        first = z.read(media[0]) if media else b""
        px = jpeg_size(first)
        print(f"   [{label}] 嵌入图实际像素: {px}（应为 {THUMB_PX}×{THUMB_PX}）")
        if px != (THUMB_PX, THUMB_PX):
            ok = False
            print(f"   FAIL 嵌入图实际像素不是 {THUMB_PX}×{THUMB_PX}")

        rels = z.read("xl/drawings/_rels/drawing1.xml.rels").decode("utf-8")
        if "../media/image1.jpeg" not in rels:
            ok = False
            print("   FAIL drawing rels 没有指向 media/image1.jpeg")
    return ok


def jpeg_size(data: bytes):
    """从 JPEG 字节里读出宽高（扫 SOF 段），不依赖 Pillow"""
    i = 2
    while i < len(data) - 9:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        # SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 都带尺寸
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB):
            h, w = struct.unpack(">HH", data[i + 5 : i + 9])
            return (w, h)
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg_len = struct.unpack(">H", data[i + 2 : i + 4])[0]
        i += 2 + seg_len
    return None


def main() -> int:
    ok = True
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    make_png(IMG_DIR / "rose.png", 400, (200, 40, 40))
    make_png(IMG_DIR / "lily.png", 320, (240, 240, 240))
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
        ok = check_price_format(all_path, "全部") and ok
        ok = check_align_and_color(all_path, "全部") and ok

        _, rows, _ = read_sheet(all_path)
        body = rows[1:]
        prices = [r.get("D") for r in body]
        sales = [r.get("E") for r in body]
        names = [r.get("B") for r in body]
        print(f"   价格列: {prices}（应为 19.98 / 199 / None）")
        print(f"   销量列: {sales}（应为 6754 / 1234 / None）")
        if prices != [19.98, 199, None]:
            ok = False
            print("   FAIL 价格不是数值或缺失值没有留空")
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
        _, rows2, _ = read_sheet(one_path)
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
