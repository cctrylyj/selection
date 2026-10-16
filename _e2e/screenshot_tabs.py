"""用 Playwright 给产品信息页两个新页签截图（headless 截图对轮询页面更可靠）。"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path("C:/Users/cctry/AppData/Local/Temp/shots2")
OUT.mkdir(parents=True, exist_ok=True)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--disable-extensions"])
        page = browser.new_page(viewport={"width": 1440, "height": 1080})
        page.goto("http://127.0.0.1:5173/products", wait_until="networkidle")
        page.wait_for_timeout(1200)
        page.screenshot(path=str(OUT / "tab-bookmarklet.png"), full_page=True)

        page.get_by_role("tab", name="粘贴导入").click()
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / "tab-import.png"), full_page=True)

        page.get_by_role("tab", name="在线检索（需配置凭证）").click()
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / "tab-online.png"), full_page=True)
        browser.close()
    print("saved:", [f.name for f in sorted(OUT.glob("*.png"))])
    return 0


if __name__ == "__main__":
    sys.exit(main())
