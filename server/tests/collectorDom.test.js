/**
 * 价格解析（拆分结构）与销量提取的离线测试。
 *
 * 背景：山姆把 $16.87 渲染成「大字整数 16 + 小字角分 87」两个节点，
 * 有时还单独渲染一个上标 $。读容器 textContent 会粘成 "$1687"，
 * 读第一个数字子节点又会丢掉角分。这里的纯函数就是干这个的。
 *
 * 列表页星级右边那个数字（★★★★★ 6754）由 countOf / salesFromCard 提取。
 * salesFromCard 依赖真实 DOM，放在 _e2e 里用 Chrome 跑 fixture 验证；
 * 这里只测纯函数部分。
 */
import assert from "node:assert/strict";
import {
  looksFullPrice,
  joinSplitPrice,
  findFullPrice,
  isPricePart,
  isNonPriceBox,
  countOf,
  PRICE_HELPER_SRC,
} from "../services/collectorDom.js";

let n = 0;
function t(name, fn) {
  try { fn(); n++; console.log("  ok -", name); }
  catch (e) { console.error("  FAIL -", name); console.error("   ", e.message); process.exitCode = 1; }
}

t("looksFullPrice：只认「确定是完整价格」的文本", () => {
  // 完整价格
  assert.equal(looksFullPrice("$19.98"), true);
  assert.equal(looksFullPrice("19.98"), true);
  assert.equal(looksFullPrice("$ 19.99"), true);
  assert.equal(looksFullPrice("1,299"), true);
  assert.equal(looksFullPrice("¥199.00"), true);
  assert.equal(looksFullPrice("12,34 €"), true);
  assert.equal(looksFullPrice("$16"), true);          // 带符号的整数价可以认

  // 裸整数不能认：它多半是拆分价格里的整数部分
  assert.equal(looksFullPrice("16"), false);
  assert.equal(looksFullPrice("496"), false);
  assert.equal(looksFullPrice("1687"), false);

  // 非价格文本
  assert.equal(looksFullPrice("无价格"), false);
  assert.equal(looksFullPrice("Save 5%"), false);
  assert.equal(looksFullPrice(""), false);
  assert.equal(looksFullPrice(null), false);
});

t("joinSplitPrice：把「整数 + 角分」拼回小数", () => {
  assert.equal(joinSplitPrice(["$", "16", "87"]), "16.87");
  assert.equal(joinSplitPrice(["4", "96"]), "4.96");
  assert.equal(joinSplitPrice(["$16", "48"]), "16.48");
  assert.equal(joinSplitPrice(["16", ".", "87"]), "16.87");
  assert.equal(joinSplitPrice(["16", ".87"]), "16.87");
  assert.equal(joinSplitPrice(["16.", "97"]), "16.97");   // 整数片段自带小数点
  assert.equal(joinSplitPrice(["16,", "97"]), "16.97");   // 欧洲式
});

t("容器性质：靠 class 分辨「价格零件」与「划线价」", () => {
  assert.equal(isNonPriceBox({ className: "sc-price-wasPrice" }), true);
  assert.equal(isNonPriceBox({ className: "Price-strikeThrough" }), true);
  assert.equal(isNonPriceBox({ className: "sc-price-characteristic" }), false);
  assert.equal(isNonPriceBox({ className: "sc-price-savings" }), false);  // 「省了多少」不算划线价

  assert.equal(isPricePart({ className: "sc-price-integer" }), true);
  assert.equal(isPricePart({ className: "sc-price-decimal" }), true);
  assert.equal(isPricePart({ className: "sc-price" }), false);
  // SVG 的 className 是对象，要读 baseVal
  assert.equal(isPricePart({ className: { baseVal: "price-cents" } }), true);
  assert.equal(isPricePart(null), false);
  assert.equal(isNonPriceBox(null), false);
});

t("joinSplitPrice：不该拼的时候不要乱拼", () => {
  assert.equal(joinSplitPrice(["19.98"]), "");            // 已经是完整价格
  assert.equal(joinSplitPrice(["$19.98"]), "");
  assert.equal(joinSplitPrice(["无价格"]), "");
  assert.equal(joinSplitPrice(["16"]), "");               // 只有整数，宁可返回空也不猜
  assert.equal(joinSplitPrice(["16", "8"]), "");          // 角分必须是两位
  assert.equal(joinSplitPrice([]), "");
  assert.equal(joinSplitPrice(null), "");
});

t("findFullPrice：取第一个完整价格，跳过裸整数", () => {
  assert.equal(findFullPrice(["16", "87"]), "");          // 拆分结构不算完整价格
  assert.equal(findFullPrice(["16", "$19.98"]), "$19.98");
  assert.equal(findFullPrice(["无价格", "$24.98"]), "$24.98");
});

t("countOf：只认「数量」，星级小数绝不能被当成销量", () => {
  // 页面上的常见写法
  assert.equal(countOf("6754"), 6754);
  assert.equal(countOf("(6754)"), 6754);
  assert.equal(countOf("1,234"), 1234);
  assert.equal(countOf(" 6754 "), 6754);
  assert.equal(countOf("1.2K"), 1200);
  assert.equal(countOf("3.4M"), 3400000);
  assert.equal(countOf("1.2万"), 12000);
  assert.equal(countOf(6754), 6754);

  // 星级评分是小数，且没有 K/M/万 后缀 → 必须拒绝
  // （否则 4.6 会被读成 5 条销量，比「空」更糟）
  assert.equal(countOf("4.6"), null);
  assert.equal(countOf("4.5"), null);
  assert.equal(countOf("4.6 out of 5 stars"), null);

  // 价格、名称里的数字、空值都不算数量
  assert.equal(countOf("$16"), null);
  assert.equal(countOf("16.87"), null);
  assert.equal(countOf("45 Rolls"), null);
  assert.equal(countOf("2-Ply"), null);
  assert.equal(countOf("无价格"), null);
  assert.equal(countOf("0"), null);      // 0 不显示，别用 0 冒充
  assert.equal(countOf(""), null);
  assert.equal(countOf(null), null);
  assert.equal(countOf(undefined), null);
});

t("注入源码：是纯函数源码，不含模块语法 / 模板字面量", () => {
  assert.ok(PRICE_HELPER_SRC.length > 500, "注入源码不应为空");
  assert.ok(PRICE_HELPER_SRC.startsWith("function looksFullPrice"), "应以第一个函数声明开头");
  assert.ok(!/(^|\n)\s*export\b/.test(PRICE_HELPER_SRC), "不能把 export 关键字注入到页面脚本里");
  assert.ok(!PRICE_HELPER_SRC.includes("`"), "不能含反引号（书签是 javascript: URL，模板字面量会出问题）");
  assert.ok(!PRICE_HELPER_SRC.includes("${"), "不能含 ${ 插值");
  assert.ok(PRICE_HELPER_SRC.includes("function priceFromCard"), "必须包含对外入口 priceFromCard");
  assert.ok(PRICE_HELPER_SRC.includes("function salesFromCard"), "必须包含对外入口 salesFromCard");
  // 货币符号要原样保留（路由用替换函数注入，不能被 $& / $' 这类序列吃掉）
  assert.ok(PRICE_HELPER_SRC.includes("[$¥€£]"), "货币符号字符集应完好");
});

t("注入源码可被 JS 引擎解析", () => {
  // 与用户在浏览器里跑的是同一段源码
  const fn = new Function(`${PRICE_HELPER_SRC}\nreturn [priceFromCard, salesFromCard, countOf];`);
  const [priceFromCard, salesFromCard, countOfInjected] = fn();
  assert.equal(typeof priceFromCard, "function");
  assert.equal(typeof salesFromCard, "function");
  assert.equal(typeof countOfInjected, "function");
  assert.equal(countOfInjected("1.2K"), 1200);
  // 没有卡片时不能抛，直接返回 null
  assert.equal(salesFromCard(null), null);
});

console.log(`\n${n} passed`);
