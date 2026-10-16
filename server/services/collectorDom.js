/**
 * 采集脚本共用的「页面侧」代码（价格提取 + 销量/评价数提取）。
 *
 * 背景（踩过的坑）：山姆把商品价格拆成两个节点渲染——大字整数 + 小字角分，
 * 还常常单独渲染一个上标 "$"。例如 $16.87 在 DOM 里长这样：
 *
 *   <div class="sc-price-characteristic">
 *     <span class="sc-price-superscript">$</span>
 *     <span class="sc-price-integer">16</span>
 *     <span class="sc-price-decimal">87</span>
 *   </div>
 *
 * 于是两种朴素写法都会读错：
 *   - 读容器的 textContent → "$1687"（粘在一起）
 *   - 读第一个匹配数字的子节点 → "16"（丢掉角分）
 *
 * 正确做法是先识别「拆分结构」，把整数节点与两位小数节点拼成 16.87。
 *
 * 另外列表页星级右边那个数字（★★★★★ 6754）也要一起采下来，
 * 见下方的 salesFromCard。
 *
 * 为什么这段代码以「源码字符串」形式存在：
 *   用户脚本（Tampermonkey）是被 readFile 原样读出的 .js 文件（不是模块，
 *   无法 import），书签则是一段 javascript: URL。两条通道必须在页面上跑
 *   同一套解析逻辑。若各自复制一份，就会出现「书签修好了、用户脚本还是旧的」。
 *   所以这里把纯函数集中定义，用 Function.prototype.toString() 生成源码字符串，
 *   由两边模板各自拼接——单一实现，不会分叉。
 *
 * 注意：这些函数最终在浏览器里执行，只能依赖 DOM API；为兼容性统一用 ES5 写法。
 */

/**
 * 只认「确定是完整价格」的文本：带货币符号 / 带千分位 / 带两位小数。
 * 单独一个 "16" 不认——它很可能是拆分价格里的整数部分，认了就会把 16.87 读成 16.00。
 */
export function looksFullPrice(t) {
  if (!t || !/\d/.test(t) || String(t).length > 12) return false;
  // 货币符号在前（$19.98）或在后（12,34 €）都算
  if (!/^[\s$¥€£]*[\d.,]+[\s$¥€£]*$/.test(t)) return false;
  return /[$¥€£]/.test(t) || /\d,\d{3}/.test(t) || /[.,]\d{2}$/.test(t);
}

/**
 * 按文档顺序收集容器里的「文本片段」：每个叶子元素 / 文本节点各算一段。
 *
 * 两个关键点：
 *   1. 不能把相邻文本粘起来——<span>16</span><span>87</span> 必须得到
 *      ["16", "87"] 而不是 "1687"；
 *   2. 划线价 / 原价（class 带 was、strike、original、compare）整棵子树跳过，
 *      免得把原价当成现价。
 */
export function textPieces(root) {
  var out = [];
  function walk(node, depth) {
    if (!node || out.length >= 32 || depth > 8) return;
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) {
        var t = String(c.nodeValue || "").replace(/\s+/g, " ").trim();
        if (t) out.push(t);
      } else if (c.nodeType === 1) {
        if (isNonPriceBox(c)) continue;
        if (c.children && c.children.length) {
          walk(c, depth + 1);
        } else {
          var t2 = String(c.textContent || "").replace(/\s+/g, " ").trim();
          if (t2) out.push(t2);
        }
      }
    }
  }
  walk(root, 0);
  return out;
}

/**
 * 在文本片段里找「整数 + 两位小数」的拆分价格，拼成 "16.87"。
 * 找不到返回空串。
 * 容忍的写法：整数片段自带货币符号（"$16"）、整数片段尾部带小数点（"16."）、
 * 小数点单独成段（"16" / "." / "97"）。
 */
export function joinSplitPrice(pieces) {
  if (!pieces || !pieces.length) return "";
  for (var i = 0; i + 1 < pieces.length; i++) {
    var iv = String(pieces[i]).match(/^[$¥€£]?\s?(\d{1,4})[.,]?$/);
    if (!iv) continue;
    var dv = String(pieces[i + 1]).match(/^[.,]?(\d{2})$/);
    if (!dv && /^[.,]$/.test(String(pieces[i + 1]))) {
      dv = String(pieces[i + 2] || "").match(/^(\d{2})$/);
    }
    if (dv) return iv[1] + "." + dv[1];
  }
  return "";
}

/** 片段里第一个「确定是完整价格」的文本（"$19.98" / "1,299.00"） */
export function findFullPrice(pieces) {
  if (!pieces || !pieces.length) return "";
  for (var i = 0; i < pieces.length; i++) {
    if (looksFullPrice(pieces[i])) return String(pieces[i]);
  }
  return "";
}

/** 价格容器：class / id / itemprop 带 price 语义（山姆的容器类是 sc-price-* 这种） */
export function priceBoxes(root) {
  var out = [];
  if (!root || !root.querySelectorAll) return out;
  try {
    var hit = root.querySelectorAll(
      '[class*="price" i],[id*="price" i],[itemprop="price"],[data-testid*="price" i]'
    );
    for (var i = 0; i < hit.length && i < 12; i++) out.push(hit[i]);
  } catch (e) { /* 老浏览器不支持属性选择器的 i 标志时忽略，走整卡片兜底 */ }
  return out;
}

/** 容器里单独渲染的货币符号（山姆是上标 $）；取不到返回空串 */
export function symbolOf(el) {
  var m = String((el && el.textContent) || "").match(/[$¥€£]/);
  return m ? m[0] : "";
}

/** 取元素的 class 文本（SVG 的 className 是对象，要取 baseVal） */
export function classNameOf(el) {
  try {
    var cn = el && el.className;
    return typeof cn === "string" ? cn : String((cn && cn.baseVal) || "");
  } catch (e) { return ""; }
}

/**
 * 划线价 / 原价：这类容器不是当前售价，选价时要跳过。
 * 注意不把「省了多少」算进来——"Save $3.11" 这种文本本来就不符合价格格式，
 * 不会被误取，多列一个关键词反而增加误伤风险。
 */
export function isNonPriceBox(el) {
  return /was|strike|original|compare/i.test(classNameOf(el));
}

/** 这个元素是不是「拆分价格的零件」（整数/小数/货币符号节点）——是的话不能当完整价格读 */
export function isPricePart(el) {
  return /integer|whole|decimal|fraction|cents|superscript|currency|symbol/i.test(classNameOf(el));
}

/**
 * 从商品卡片里取价格文本（"$16.87" / "19.98"），取不到返回 null。
 *
 * 每个价格容器里都是「先找拆分价格，再找完整价格」：
 *   拆分价格优先，否则 "16" 这种整数叶子会被当成完整价格读成 16.00；
 *   完整价格那一轮跳过拆分零件节点（整数/小数/货币符号），原因同上。
 * 容器顺序：先看非划线价的容器，都被排除了才回头看划线价容器；
 * 都没有再退到整张卡片（站点没有 price 语义 class 时）。
 */
export function priceFromCard(card) {
  if (!card) return null;

  var boxes = priceBoxes(card);
  var clean = [];
  for (var i = 0; i < boxes.length; i++) {
    if (!isNonPriceBox(boxes[i])) clean.push(boxes[i]);
  }
  // 万一整页只有划线价（极少见），也别把价格丢掉
  var list = clean.length ? clean : boxes;

  for (var k = 0; k < list.length; k++) {
    var sp = joinSplitPrice(textPieces(list[k]));
    if (sp) return (symbolOf(list[k]) || symbolOf(card)) + sp;
    if (isPricePart(list[k])) continue;
    var fp = findFullPrice(textPieces(list[k]));
    if (fp) return fp;
  }

  var cs = joinSplitPrice(textPieces(card));
  if (cs) return symbolOf(card) + cs;
  return findFullPrice(textPieces(card)) || null;
}

/* ------------------------------------------------------------------ *
 * 销量 / 评价数
 * ------------------------------------------------------------------ */

/**
 * 把 "6754" / "(6,754)" / "1.2K" / "1.2万" 解析成整数；不是「数量」则返回 null。
 *
 * 关键：没有 K/M/万 后缀时，**带小数点的数字不算数量**——那通常是星级评分
 * （4.6 / 4.5），混进来会把 4.6 当成 5 条评价。带后缀时允许小数（1.2K → 1200）。
 * 也不认负数与 0，销量为 0 的商品页面上本来就不显示这个数字。
 */
export function countOf(t) {
  var s = String(t === null || t === undefined ? "" : t).replace(/\s+/g, "");
  if (!s) return null;
  var m = s.match(/^\(?(\d[\d,]*)(?:\.(\d+))?(K|k|M|m|万)?\)?$/);
  if (!m) return null;
  var suffix = m[3] || "";
  if (!suffix && m[2] !== undefined) return null; // 4.6 是星级，不是数量
  var num = Number(m[1].replace(/,/g, "") + (m[2] ? "." + m[2] : ""));
  if (!isFinite(num) || num <= 0) return null;
  if (suffix === "K" || suffix === "k") num *= 1000;
  else if (suffix === "M" || suffix === "m") num *= 1000000;
  else if (suffix === "万") num *= 10000;
  return Math.round(num);
}

/**
 * 星级 / 评价容器：class、id、itemprop、data-testid 里带 rating / review / star 语义。
 * 山姆列表页是 sc-product-rating 这类命名，亚马逊是 a-icon-star 那一带。
 */
export function ratingBoxes(root) {
  var out = [];
  if (!root || !root.querySelectorAll) return out;
  try {
    var hit = root.querySelectorAll(
      '[class*="rating" i],[class*="review" i],[class*="star" i],'
      + '[id*="rating" i],[id*="review" i],'
      + '[itemprop="aggregateRating"],[itemprop="ratingCount"],[itemprop="reviewCount"],'
      + '[data-testid*="rating" i],[data-testid*="review" i]'
    );
    for (var i = 0; i < hit.length && i < 8; i++) out.push(hit[i]);
  } catch (e) { /* 老浏览器不支持属性选择器的 i 标志时忽略 */ }
  return out;
}

/**
 * 收集「数量候选」文本片段：和 textPieces 一样按标签边界拆，但额外
 * **整棵跳过价格相关子树**。
 *
 * 为什么必须跳过：山姆的价格是 <span>19</span><span>98</span> 这种拆分结构，
 * 一旦价格节点混进来，"19" 会被 countOf 当成销量 19。同理 "starting price"
 * 这类 class 里带 star 的容器也会被误判成星级容器。
 */
export function countPieces(root) {
  var out = [];
  function walk(node, depth) {
    if (!node || out.length >= 16 || depth > 8) return;
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) {
        var t = String(c.nodeValue || "").replace(/\s+/g, " ").trim();
        if (t) out.push(t);
      } else if (c.nodeType === 1) {
        if (/price|amount|was|strike|original|compare/i.test(classNameOf(c) + " " + String(c.id || ""))) continue;
        if (c.children && c.children.length) {
          walk(c, depth + 1);
        } else {
          var t2 = String(c.textContent || "").replace(/\s+/g, " ").trim();
          if (t2) out.push(t2);
        }
      }
    }
  }
  walk(root, 0);
  return out;
}

/** 从元素里抠出一个「数量」：先整段文本，再按标签边界拆片段（跳过价格子树） */
export function countIn(el) {
  if (!el) return null;
  // 元素本身就是价格容器时直接放弃：否则它的拆分零件（"19" / "98"）
  // 会被当成销量。注意要连 dollars / cents 这类零件一起挡掉，
  // 它们自己不带 price 字样，是靠父级 class 认出来的。
  if (/price|amount|was|strike|original|compare|dollar|cent|integer|decimal|fraction|superscript|currency|symbol/i
    .test(classNameOf(el) + " " + String(el.id || ""))) return null;
  var direct = countOf(el.textContent);
  if (direct !== null) return direct;
  var pieces = countPieces(el);
  for (var i = 0; i < pieces.length; i++) {
    var v = countOf(pieces[i]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * 从商品卡片取「销量 / 评价数」（整数），取不到返回 null。
 *
 * 页面上的形态：
 *   山姆列表页   星级右边紧跟一个裸数字          ★★★★★ 6754
 *   亚马逊       文案带单位词                  1,234 ratings
 *   TikTok Shop  文案带单位词                  1.2K sold
 *   详情页       JSON-LD aggregateRating.reviewCount（走 parseProduct，不在这里）
 *
 * 四级降级，全部锚定在「评分 / 评价」语义上——不做整卡片扫数字，
 * 那会把「50 stems」「2-Ply」「$16」这类误当成销量，宁可为空。
 */
export function salesFromCard(card) {
  if (!card) return null;

  // 1) 结构化标注（schema.org 微数据 / 站点自定义 data-*）
  try {
    var marked = card.querySelectorAll(
      '[itemprop="ratingCount"],[itemprop="reviewCount"],[data-testid*="review-count" i]'
    );
    for (var i = 0; i < marked.length && i < 6; i++) {
      var raw = marked[i].getAttribute("content")
        || marked[i].getAttribute("data-count")
        || marked[i].textContent;
      var v = countOf(raw);
      if (v !== null) return v;
    }
  } catch (e) { /* 选择器不支持时继续往下走 */ }

  // 2) aria-label / title 里带单位词的文案
  var labeled = card.querySelectorAll("[aria-label],[title]");
  for (var j = 0; j < labeled.length && j < 12; j++) {
    var txt = String(labeled[j].getAttribute("aria-label") || labeled[j].getAttribute("title") || "");
    var m = txt.match(/(\d[\d,.]*\s*[KkMm万]?)\s*(reviews?|ratings?|sold|评价|条评价|销量)/i);
    if (m) {
      var v2 = countOf(String(m[1]).replace(/\s+/g, ""));
      if (v2 !== null) return v2;
    }
  }

  // 3) 星级容器里的裸数字（山姆列表页就是这个形态）
  var boxes = ratingBoxes(card);
  for (var k = 0; k < boxes.length; k++) {
    var v3 = countIn(boxes[k]);
    if (v3 !== null) return v3;
  }

  // 4) 有的站点把数量放在星级容器外面，紧跟其后的兄弟节点里。
  //    这里必须要求兄弟节点自身带「数量 / 评价」语义 —— 否则很容易
  //    把相邻的价格节点（拆分的 "19" / "98"）当成销量。
  for (var q = 0; q < boxes.length; q++) {
    var sib = boxes[q].nextElementSibling;
    for (var hop = 0; sib && hop < 3; hop++) {
      var meta = classNameOf(sib) + " " + String(sib.id || "") + " "
        + String(sib.getAttribute("data-testid") || "");
      if (/count|review|rating|sold/i.test(meta)) {
        var v4 = countIn(sib);
        if (v4 !== null) return v4;
      }
      sib = sib.nextElementSibling;
    }
  }
  return null;
}

/** 注入到浏览器脚本里的源码：各函数的源码文本，按依赖顺序排列 */
export const PRICE_HELPER_SRC = [
  looksFullPrice,
  classNameOf,
  isNonPriceBox,
  isPricePart,
  textPieces,
  joinSplitPrice,
  findFullPrice,
  priceBoxes,
  symbolOf,
  priceFromCard,
  countOf,
  ratingBoxes,
  countPieces,
  countIn,
  salesFromCard,
].map((f) => f.toString()).join("\n\n");
