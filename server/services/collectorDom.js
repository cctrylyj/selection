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
  if (!/^[\s$¥￥＄€£]*[\d.,]+[\s$¥￥＄€£]*$/.test(t)) return false;
  return /[$¥￥＄€£]/.test(t) || /\d,\d{3}/.test(t) || /[.,]\d{2}$/.test(t);
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
  var m = String((el && el.textContent) || "").match(/[$¥￥＄€£]/);
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

/* ------------------------------------------------------------------ *
 * 列表页卡片识别（亚马逊）
 *
 * 为什么单独做一套：山姆列表页的商品链接是 /ip/xxx，亚马逊是 /dp/ASIN，
 * 原先列表采集只按 /ip/ 找锚点，在亚马逊上一条都找不到，于是整页被当成
 * 「一个商品」提交——商品名变成页面标题 "Amazon.com: Flowers - $5 To $25"，
 * 价格/图片/销量全空。这就是「亚马逊无登录采集有问题」的真正原因。
 *
 * 亚马逊搜索结果的卡片结构（中英文站点一致）：
 *   <div data-component-type="s-search-result" data-asin="B0XXXXXXX">
 *     <h2>...标题...</h2>
 *     <a href="/dp/B0XXXXXXX/ref=...">...</a>
 *     <img class="s-image" src="...">
 *     <span class="a-price"><span class="a-offscreen">$19.99</span>...</span>
 *     <span class="a-price a-text-price"><span class="a-offscreen">$29.99</span></span>  ← 划线原价，必须跳过
 *     <a href="...#customerReviews"><span>5K</span></a>
 *   </div>
 * ------------------------------------------------------------------ */

/** 亚马逊商品卡片：广告位/占位卡没有 data-asin，直接跳过 */
export function amazonCards(root) {
  var doc = root || document;
  var out = [];
  var nodes;
  try {
    nodes = doc.querySelectorAll(
      'div[data-component-type="s-search-result"], div.s-result-item[data-asin]'
    );
  } catch (e) {
    return out;
  }
  for (var i = 0; i < nodes.length; i++) {
    var asin = nodes[i].getAttribute("data-asin");
    // 真 ASIN 是 10 位字母数字；空字符串的卡片是占位/广告
    if (asin && asin.length >= 8) out.push(nodes[i]);
  }
  return out;
}

/** 卡片标题：h2 里的文本最干净，其次链接文本，最后退到图片 alt */
export function amazonTitle(card) {
  if (!card) return "";
  var t = "";
  var h2 = card.querySelector("h2");
  if (h2) t = h2.innerText || h2.textContent || "";
  if (!t) {
    var a = card.querySelector('a[href*="/dp/"]');
    t = a ? (a.getAttribute("aria-label") || a.textContent || "") : "";
  }
  if (!t) {
    var img = card.querySelector("img");
    t = img ? (img.alt || "") : "";
  }
  return String(t).replace(/\s+/g, " ").trim();
}

/**
 * 商品链接：统一成 origin + /dp/ASIN。
 * 亚马逊的 href 带一大堆跟踪参数（ref= / th= / psc=），留着会让同一个商品
 * 在不同页面算出不同的 channelKey，去重和对比都会失效。
 */
export function amazonLink(card) {
  if (!card) return "";
  var a = card.querySelector('a[href*="/dp/"]') || card.querySelector("h2 a");
  if (!a) return "";
  var href = String(a.getAttribute("href") || a.href || "");
  var m = href.match(/\/dp\/([A-Za-z0-9]{10})/);
  if (!m) return href.split("#")[0].split("?")[0];
  var origin = /^https?:/i.test(location.href) ? location.origin : "https://www.amazon.com";
  return origin + "/dp/" + m[1];
}

/**
 * 价格文本（保留货币符号，交给服务端 parsePrice 推币种）。
 * 关键：必须排除 .a-text-price（划线原价），否则会把 "原价 29.99" 当现价。
 */
export function amazonPrice(card) {
  if (!card) return null;
  var el = card.querySelector(".a-price:not(.a-text-price) .a-offscreen")
    || card.querySelector(".a-price:not(.a-text-price)");
  var txt = el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  // 只要文本里带数字就交给服务端解析；"Currently unavailable" 这种没有数字，走兜底
  if (txt && /\d/.test(txt) && txt.length <= 24) return txt;
  return priceFromCard(card);
}

/**
 * 销量 / 评价数。
 *
 * 优先取「评价数」：星级旁边那个链接（a[href*=customerReviews]），
 * 中文站点文本是 "5K"/"500"，aria-label 是 "4.6 星，5000 条评价"；
 * 英文是 "5,000 ratings"。
 * 取不到再退到 "过去一个月购买了700多件商品" / "700+ bought in past month"。
 * 后者一定要锚定完整句子——只匹配「N 件」会把标题里的 "12 支装" 当成销量。
 */
export function amazonSales(card) {
  if (!card) return null;

  var link = card.querySelector('a[href*="customerReviews"], a[href*="#customerReviews"]');
  if (link) {
    var label = String(link.getAttribute("aria-label") || "");
    var m = label.match(/([\d.,]+\s*[KkMm万]?)\s*(条评价|评价|ratings?|reviews?)/i);
    var v = m ? countOf(String(m[1]).replace(/\s+/g, "")) : countOf(link.textContent);
    if (v !== null) return v;
  }

  var generic = salesFromCard(card);
  if (generic !== null) return generic;

  var text = String(card.textContent || "").replace(/\s+/g, " ");
  var sold = text.match(/过去一个月购买了\s*([\d.,]+\s*[KkMm万]?)\s*(?:多)?\s*件/)
    || text.match(/([\d.,]+\s*[KkMm]?)\s*\+?\s*bought in past month/i);
  if (sold) {
    var n = countOf(String(sold[1]).replace(/\s+/g, ""));
    if (n !== null) return n;
  }
  return null;
}

/**
 * 亚马逊列表页整页解析，返回 items 或 null（不足 3 条视为不是列表页）。
 * 不去重：页面里出现几次就采几次，与山姆列表保持一致。
 */
export function amazonListItems(max) {
  var cards = amazonCards(document);
  var limit = max || 60;
  var items = [];
  for (var i = 0; i < cards.length && items.length < limit; i++) {
    var card = cards[i];
    var url = amazonLink(card);
    var title = amazonTitle(card);
    if (!url || !title || title.length < 6) continue;
    var img = card.querySelector("img.s-image") || card.querySelector("img");
    items.push({
      url: url,
      title: title,
      price: amazonPrice(card),
      image: img ? (img.currentSrc || img.src || "") : "",
      sales: amazonSales(card),
    });
  }
  return items.length >= 3 ? items : null;
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
  // 亚马逊列表页专用（放在最后，依赖上面的 priceFromCard / countOf / salesFromCard）
  amazonCards,
  amazonTitle,
  amazonLink,
  amazonPrice,
  amazonSales,
  amazonListItems,
].map((f) => f.toString()).join("\n\n");
