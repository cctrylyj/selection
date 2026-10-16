// 离线校验山姆渠道的解析/匹配逻辑（不需要凭证与网络）
// 运行：node server/tests/samsclub.test.js
import assert from "node:assert/strict";

const { parseLocs, isCategoryUrl, rankCategories, extractProductUrls } = await import(
  "../crawlers/samsclub.js"
);

// ---------- sitemap 遍历 ----------
const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex>
  <sitemap><loc>https://www.samsclub.com/sitemap-categories-1.xml</loc></sitemap>
  <sitemap><loc>https://www.samsclub.com/sitemap-categories-2.xml</loc></sitemap>
  <sitemap><loc>https://www.samsclub.com/sitemap-products-1.xml</loc></sitemap>
</sitemapindex>`;

const locs = parseLocs(SITEMAP_INDEX);
assert.equal(locs.length, 3);
assert.ok(locs.every((l) => l.startsWith("https://")));
console.log(`parseLocs: 从 sitemap 索引解析出 ${locs.length} 个子 sitemap`);

const CATEGORY_SITEMAP = `<urlset>
  <url><loc>https://www.samsclub.com/c/bath-tissue/1144</loc></url>
  <url><loc>https://www.samsclub.com/c/coffee/1123</loc></url>
  <url><loc>https://www.samsclub.com/c/kitchen-dining-supplies/2401</loc></url>
</urlset>`;
const categoryUrls = parseLocs(CATEGORY_SITEMAP).filter(isCategoryUrl);
assert.equal(categoryUrls.length, 3);

// 商品链接不应被当成类目页
assert.equal(isCategoryUrl("https://www.samsclub.com/ip/mark-bath-tissue/1425143980"), false);
assert.equal(isCategoryUrl("https://www.samsclub.com/c/bath-tissue/1144"), true);
assert.equal(isCategoryUrl("https://www.samsclub.com/search?searchTerm=x"), false);
console.log("isCategoryUrl: /c/ 识别正确，/ip/、/search 均不受影响");

// ---------- 关键词 → 类目匹配 ----------
const all = [
  ...categoryUrls,
  "https://www.samsclub.com/c/pet-supplies/2409",
  "https://www.samsclub.com/c/baby-products/1141",
  "https://www.samsclub.com/c/bathroom-accessories/1210",
];

const hit = rankCategories(all, "bath tissue", 3);
assert.equal(hit[0], "https://www.samsclub.com/c/bath-tissue/1144", "bath tissue 应命中 /c/bath-tissue/");
console.log(`rankCategories: "bath tissue" → ${hit[0]}`);

// 词序无关：反过来输入也命中
assert.equal(rankCategories(all, "tissue bath", 3)[0], "https://www.samsclub.com/c/bath-tissue/1144");

// 中文走英文品名；单字词（<2 字符）不应参与匹配造成误命中
assert.deepEqual(rankCategories(all, "咖啡豆", 3), []);

// 不存在的类型返回空
assert.deepEqual(rankCategories(all, "quantum furnace", 3), []);

// maxResults 生效
assert.equal(rankCategories(all, "bath", 2).length, 2);
console.log("rankCategories: 词序无关 / 空结果 / 数量截断均正确");

// ---------- 类目页 → 商品链接 ----------
const LISTING_HTML = `
<html><body>
  <a href="/ip/member-s-mark-bath-tissue/1425143980">A</a>
  <a href="/ip/another-tissue/1425143981">B</a>
  <a href="/ip/member-s-mark-bath-tissue/1425143980">A 重复</a>
  <a href="https://www.samsclub.com/ip/absolute-form/999">C</a>
  <a href="/c/bath-tissue/1144">类目</a>
  <a href="/cart">购物车</a>
</body></html>`;

const products = extractProductUrls(LISTING_HTML, 10);
// 不做去重：页面上出现两次的链接就产出两条（商品本身唯一，不去重）
assert.equal(products.length, 4, `应产出 4 条商品链接（含重复那条），实际 ${products.length}`);
assert.ok(products.every((u) => u.startsWith("https://www.samsclub.com/ip/")));
// 相对路径补成绝对地址
assert.ok(products.includes("https://www.samsclub.com/ip/member-s-mark-bath-tissue/1425143980"));
// 非商品链接不混进来
assert.ok(!products.some((u) => u.includes("/c/") || u.includes("/cart")));
console.log(`extractProductUrls: ${products.length} 条，全部规整为绝对 /ip/ 链接（不去重）`);

// limit 生效
assert.equal(extractProductUrls(LISTING_HTML, 2).length, 2);

// 空页面不炸
assert.deepEqual(extractProductUrls("<html></html>", 5), []);

console.log("\n山姆渠道解析测试全部通过");
