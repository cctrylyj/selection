/** 本地采集（零凭证路径）的离线解析测试 */
import assert from "node:assert/strict";
import {
  parseProduct,
  parseProductFromJsonLd,
  collectFromPayload,
  collectListFromPayload,
  drainInbox,
  removeFromInbox,
} from "../services/localCollect.js";
import { toCount } from "../crawlers/base.js";

// 采集入库是异步的（部署到 Vercel 时收件箱可能落在 Redis 上），
// 所以这里先收集用例，最后统一 await 执行。
const cases = [];
function t(name, fn) {
  cases.push([name, fn]);
}

const SAM_LIKE = `<!doctype html><html><head>
<meta property="og:title" content="Member's Mark Bath Tissue, 2-Ply, 45 Rolls">
<meta property="og:image" content="https://scene7.samsclub.com/is/image/samsclub/0001234p?fmt=jpg">
<meta property="product:price:amount" content="24.98">
<meta property="product:price:currency" content="USD">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Member's Mark Bath Tissue, 2-Ply, 45 Rolls",
"sku":"1425143980","brand":{"@type":"Brand","name":"Member's Mark"},
"category":"Grocery > Paper Goods",
"image":["https://scene7.samsclub.com/is/image/samsclub/0001234p?fmt=jpg","https://scene7.samsclub.com/is/image/samsclub/0001235p?fmt=jpg"],
"description":"Strong, soft 2-ply bath tissue. 45 rolls.",
"aggregateRating":{"@type":"AggregateRating","ratingValue":"4.6","reviewCount":"3821"},
"offers":{"@type":"Offer","price":"24.98","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
</script></head><body><h1>Member's Mark Bath Tissue, 2-Ply, 45 Rolls</h1></body></html>`;

const OG_ONLY = `<!doctype html><html><head>
<meta property="og:title" content="Some Gadget Pro 2026">
<meta property="og:image" content="https://cdn.example.com/g.jpg">
<meta property="og:description" content="A gadget.">
<meta property="product:price:amount" content="$1,299.00">
</head><body><div>no structured data here</div></body></html>`;

const DOM_ONLY = `<html><head><title>Widget X - 好站点</title></head>
<body><h1>Widget X 3-pack</h1>
<span class="price">$ 19.99</span>
<ol class="breadcrumb"><li><a>Home</a></li><li><a>Kitchen</a></li><li><a>Storage</a></li></ol>
<img src="https://cdn.example.com/w.jpg">
</body></html>`;

// 山姆列表页/详情页的真实写法：价格被拆成「大字整数 + 小字角分」两个节点，
// 另外单独渲染一个上标 $。直接抓文本会粘成 "$1687"。
const SPLIT_DOM = `<html><head><title>Split Price Item</title></head>
<body><h1>Split Price Item 12oz</h1>
<div class="sc-price-characteristic">
  <span class="sc-price-superscript">$</span><span class="sc-price-integer">16</span><span class="sc-price-decimal">87</span>
</div>
</body></html>`;

// 拆分价格的另一种写法：整数节点自带 $，零件 class 不叫 integer/decimal
const SPLIT_DOM_2 = `<html><head><title>Split Price Item 2</title></head>
<body><h1>Split Price Item 2</h1>
<div class="sc-price-block"><span class="dollars">$4</span><span class="cents">96</span></div>
</body></html>`;

t("JSON-LD 路径：字段与来源", () => {
  const p = parseProduct(SAM_LIKE, { channel: "samsclub", url: "https://www.samsclub.com/ip/members-mark-bath-tissue/1425143980" });
  assert.equal(p.productName, "Member's Mark Bath Tissue, 2-Ply, 45 Rolls");
  assert.equal(p.channelKey, "1425143980");
  assert.equal(p.price, 24.98);
  assert.equal(p.currency, "USD");
  assert.equal(p.imageUrl, "https://scene7.samsclub.com/is/image/samsclub/0001234p?fmt=jpg");
  assert.equal(p.category, "Grocery > Paper Goods");
  assert.equal(p.source, "local");
  // 销量取 aggregateRating.reviewCount（3821），不是 ratingValue（4.6）
  assert.equal(p.sales, 3821);
  assert.ok(p.description.includes("2-ply"));
});

t("toCount：销量归一化，星级小数与非数量文本一律拒绝", () => {
  assert.equal(toCount(6754), 6754);
  assert.equal(toCount("6754"), 6754);
  assert.equal(toCount("6,754"), 6754);
  assert.equal(toCount("(6754)"), 6754);
  assert.equal(toCount("1.2K"), 1200);
  assert.equal(toCount("3.4M"), 3400000);
  assert.equal(toCount("1.2万"), 12000);

  assert.equal(toCount("4.6"), null);          // 星级评分
  assert.equal(toCount("4.5 out of 5"), null);
  assert.equal(toCount("$16"), null);
  assert.equal(toCount("45 Rolls"), null);
  assert.equal(toCount(0), null);              // 0 不写，别用 0 冒充
  assert.equal(toCount("0"), null);
  assert.equal(toCount(-3), null);
  assert.equal(toCount(""), null);
  assert.equal(toCount(null), null);
  assert.equal(toCount(undefined), null);
});

t("销量：ratingValue 是星级，绝不能被当成销量", () => {
  const onlyRating = `<html><head><title>Only Stars</title></head><body><h1>Only Stars</h1>
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product","name":"Only Stars","sku":"SS1",
  "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.6"}}
  </script></body></html>`;
  const p = parseProduct(onlyRating, { channel: "samsclub", url: "https://www.samsclub.com/ip/only-stars/SS1" });
  assert.equal(p.sales, null, "只有 ratingValue 时应为 null，而不是把 4.6 读成 5");
});

t("销量：页面文案兜底（1,234 ratings / 1.2K sold）", () => {
  const withText = (t) => `<html><head><title>Text Count</title></head><body><h1>Text Count</h1>
  <div class="rating"><span class="stars">4.6</span> <span>${t}</span></div></body></html>`;
  assert.equal(
    parseProduct(withText("1,234 ratings"), { channel: "amazon", url: "https://www.amazon.com/dp/B0COUNT0001" }).sales,
    1234
  );
  assert.equal(
    parseProduct(withText("1.2K sold"), { channel: "tiktokshop", url: "https://shop.tiktok.com/view/product/9001" }).sales,
    1200
  );
  // 只有星级、没有数量文案 → null
  assert.equal(
    parseProduct(withText("4.6 out of 5 stars"), { channel: "amazon", url: "https://www.amazon.com/dp/B0COUNT0002" }).sales,
    null
  );
});

t("og meta 兜底 + 千分位价格", () => {
  const p = parseProduct(OG_ONLY, { channel: "amazon", url: "https://www.amazon.com/dp/B0EXAMPLE123" });
  assert.equal(p.productName, "Some Gadget Pro 2026");
  assert.equal(p.price, 1299);
  assert.equal(p.currency, "USD");
  assert.match(p.channelKey, /^B0EXAMPLE123$/);
});

t("DOM 兜底：title 站名后缀 + 面包屑", () => {
  const p = parseProduct(DOM_ONLY, { channel: "tiktokshop", url: "https://shop.tiktok.com/view/product/12345" });
  assert.equal(p.productName, "Widget X 3-pack");
  assert.equal(p.price, 19.99);
  assert.equal(p.category, "Home > Kitchen > Storage");
  assert.equal(p.imageUrl, "https://cdn.example.com/w.jpg");
});

t("DOM 拆分价格：大字整数 + 小字角分要拼成 16.87（不是 1687 / 16）", () => {
  const p = parseProduct(SPLIT_DOM, { channel: "samsclub", url: "https://www.samsclub.com/ip/split-price/1425143980" });
  assert.equal(p.productName, "Split Price Item 12oz");
  assert.equal(p.price, 16.87);
  assert.equal(p.currency, "USD");
});

t("DOM 拆分价格：整数节点自带 $ 也要拼对（$4 + 96 → 4.96）", () => {
  const p = parseProduct(SPLIT_DOM_2, { channel: "samsclub", url: "https://www.samsclub.com/ip/split-price-2/1425143981" });
  assert.equal(p.price, 4.96);
  assert.equal(p.currency, "USD");
});

t("JSON-LD 片段可直接解析", () => {
  const frag = JSON.stringify({ "@type": "Product", name: "Coffee Beans 2lb", sku: "99887766", offers: { price: 21.5, priceCurrency: "USD" } });
  const p = parseProductFromJsonLd(frag, { channel: "samsclub", url: "https://www.samsclub.com/ip/x/99887766" });
  assert.equal(p.productName, "Coffee Beans 2lb");
  assert.equal(p.price, 21.5);
});

t("书签降级：只有显式字段也能入库", async () => {
  const rec = await collectFromPayload({ channel: "amazon", url: "https://www.amazon.com/dp/B0ABCDEFGH", title: "Fallback Item", price: "12.34" });
  assert.equal(rec.product.productName, "Fallback Item");
  assert.equal(rec.product.price, 12.34);
  assert.equal(rec.product.channelKey, "B0ABCDEFGH");
});

t("价格币种：按采集文本里的金额符号判定（列表页批采走的就是这条路）", async () => {
  const usd = await collectListFromPayload({
    channel: "samsclub",
    listUrl: "https://www.samsclub.com/s/flowers",
    items: [{ url: "https://www.samsclub.com/ip/rose/98001", title: "Red Roses Bouquet", price: "$19.98" }],
  });
  assert.equal(usd.inserted, 1);
  const usdItem = (await drainInbox("")).find((x) => x.product.channelKey === "98001");
  assert.equal(usdItem.product.price, 19.98);
  assert.equal(usdItem.product.currency, "USD");

  const cny = await collectFromPayload({
    channel: "samsclub",
    url: "https://www.samsclub.com/ip/lily/98002",
    title: "White Lily",
    price: "¥199.00",
  });
  assert.equal(cny.product.price, 199);
  assert.equal(cny.product.currency, "CNY");

  const eur = await collectFromPayload({
    channel: "amazon",
    url: "https://www.amazon.com/dp/B0EUR00001",
    title: "Euro Item",
    price: "12,34 €",
  });
  assert.equal(eur.product.price, 12.34);
  assert.equal(eur.product.currency, "EUR");
});

t("列表页批采：整批一次写入，条数与 id 都齐", async () => {
  const res = await collectListFromPayload({
    channel: "samsclub",
    listUrl: "https://www.samsclub.com/s/flowers",
    items: [
      { url: "https://www.samsclub.com/ip/a/70001", title: "Batch Item A", price: "$1.11" },
      { url: "https://www.samsclub.com/ip/b/70002", title: "Batch Item B", price: "$2.22" },
      { url: "not-a-url", title: "脏数据" },
    ],
  });
  assert.equal(res.count, 3);
  assert.equal(res.inserted, 2);
  assert.equal(res.skipped, 1);

  const all = await drainInbox("");
  const mine = all.filter((x) => /7000[12]/.test(x.product.channelKey));
  assert.equal(mine.length, 2);
  assert.ok(mine.every((x) => x.id && x.id.startsWith("c_")), "每条记录都要有唯一 id");
  assert.equal(new Set(mine.map((x) => x.id)).size, 2, "同一批里的 id 不能重复");
});

t("收件箱：sinceId 之后只返回新增", async () => {
  const before = await drainInbox("");
  const a = await collectFromPayload({ channel: "samsclub", url: "https://www.samsclub.com/ip/a/1", title: "A" });
  const after = await drainInbox("");
  assert.equal(after.length, before.length + 1);
  const delta = await drainInbox(before.length ? before[before.length - 1].id : "");
  assert.ok(delta.length >= 1);
  assert.ok(delta.some((x) => x.id === a.id));
});

t("收件箱：id 按插入顺序可比大小", async () => {
  const res = await collectListFromPayload({
    channel: "samsclub",
    listUrl: "https://www.samsclub.com/s/flowers",
    items: [
      { url: "https://www.samsclub.com/ip/ord/90001", title: "Ord 1" },
      { url: "https://www.samsclub.com/ip/ord/90002", title: "Ord 2" },
      { url: "https://www.samsclub.com/ip/ord/90003", title: "Ord 3" },
    ],
  });
  assert.equal(res.inserted, 3);
  const mine = (await drainInbox("")).filter((x) => /9000[123]/.test(x.product.channelKey));
  assert.equal(mine.length, 3);
  const ids = mine.map((x) => x.id);
  assert.deepEqual(ids, [...ids].sort(), "同一批的 id 字符串排序结果应等于插入顺序");
  await removeFromInbox(ids);
});

t("收件箱：游标那条被删掉后，轮询不会把历史拉回来", async () => {
  // 历史 3 条
  const h = await collectListFromPayload({
    channel: "samsclub",
    listUrl: "https://www.samsclub.com/s/history",
    items: [
      { url: "https://www.samsclub.com/ip/h/80001", title: "历史 1" },
      { url: "https://www.samsclub.com/ip/h/80002", title: "历史 2" },
      { url: "https://www.samsclub.com/ip/h/80003", title: "历史 3" },
    ],
  });
  assert.equal(h.inserted, 3);
  const history = (await drainInbox("")).filter((x) => /8000[123]/.test(x.product.channelKey));
  const cursorBase = history[history.length - 1].id;

  // 之后又采集 2 条，前端把游标推进到最新那条
  const f = await collectListFromPayload({
    channel: "samsclub",
    listUrl: "https://www.samsclub.com/s/fresh",
    items: [
      { url: "https://www.samsclub.com/ip/f/81001", title: "新增 1" },
      { url: "https://www.samsclub.com/ip/f/81002", title: "新增 2" },
    ],
  });
  assert.equal(f.inserted, 2);
  const fresh = (await drainInbox("")).filter((x) => /8100[12]/.test(x.product.channelKey));
  const cursor = fresh[fresh.length - 1].id;
  assert.ok(cursor > cursorBase, "新采集的 id 必须大于历史 id");

  // 用户把刚采的 2 条全删了：游标那条随之消失
  assert.equal(await removeFromInbox(fresh.map((x) => x.id)), 2);

  // 关键断言：此时用旧游标拉增量，历史那 3 条不能被返回
  const delta = await drainInbox(cursor);
  const historyIds = new Set(history.map((x) => x.id));
  assert.equal(
    delta.filter((x) => historyIds.has(x.id)).length,
    0,
    "游标被删后不能退化成整表返回"
  );

  await removeFromInbox(history.map((x) => x.id));
});

t("无任何字段时给出可读错误", async () => {
  await assert.rejects(
    () => collectFromPayload({ channel: "samsclub", url: "https://www.samsclub.com/ip/x/1" }),
    /没能从页面解析出商品/
  );
});

let passed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    passed++;
    console.log("  ok -", name);
  } catch (e) {
    console.error("  FAIL -", name);
    console.error("   ", e.message);
    process.exitCode = 1;
  }
}

console.log(`\n${passed} passed`);
