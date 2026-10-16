/**
 * 书签采集器（bookmarklet）代码生成。
 *
 * 用户把生成的链接拖到浏览器书签栏，之后在任意商品详情页点一下该书签，
 * 当前页面的商品信息就会 POST 到本系统。请求来自用户自己的浏览器，
 * 不经过本服务出口，因此不需要代理、不需要服务商账号。
 */

import { PRICE_HELPER_SRC } from "./collectorDom.js";

const BOOKMARKLET_TEMPLATE = (base, defaultChannel) => `javascript:(function(){
  var BASE = ${JSON.stringify(base)};
  var DEFAULT_CH = ${JSON.stringify(defaultChannel)};
  function attr(sel, a) { var e = document.querySelector(sel); return e ? (e.getAttribute(a) || e.textContent || "").trim() : ""; }
  function findProduct(n) {
    if (!n || typeof n !== "object") return null;
    if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { var r = findProduct(n[i]); if (r) return r; } return null; }
    var t = n["@type"]; var ts = Array.isArray(t) ? t : [t];
    var hit = false; for (var i = 0; i < ts.length; i++) { if (String(ts[i]).toLowerCase() === "product") hit = true; }
    if (hit) return n;
    var keys = Object.keys(n);
    for (var j = 0; j < keys.length; j++) { var r2 = findProduct(n[keys[j]]); if (r2) return r2; }
    return null;
  }
  function toast(msg, ok) {
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;z-index:2147483647;top:16px;right:16px;max-width:320px;padding:10px 14px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;background:" + (ok ? "#16a34a" : "#dc2626") + ";color:#fff";
    d.textContent = msg;
    document.documentElement.appendChild(d);
    setTimeout(function () { d.remove(); }, 4200);
  }

  /* ---------- 与用户脚本共用的页面解析（见 server/services/collectorDom.js）----------
     山姆把价格拆成「大字整数 + 小字角分」两个节点，有时还单独渲染一个上标 $。
     读容器 textContent 会粘成 "$1687"，读第一个数字子节点又会丢掉角分，
     所以这里用同一份实现做「拆分结构识别」。
     同一段代码里也带着销量提取（星级右边那个数字，如 ★★★★★ 6754）。 */
  ${PRICE_HELPER_SRC}

  var url = location.href.split("#")[0];
  var ch = DEFAULT_CH;
  if (/samsclub\\.com/i.test(url)) ch = "samsclub";
  else if (/amazon\\./i.test(url)) ch = "amazon";
  else if (/tiktok/i.test(url)) ch = "tiktokshop";

  /* ---------- 列表页：一次采集整页商品 ---------- */
  function collectList() {
    var anchors = document.querySelectorAll('a[href*="/ip/"]');
    if (anchors.length < 3) return false;
    var items = [];
    for (var i = 0; i < anchors.length && items.length < 60; i++) {
      var a = anchors[i];
      var href = (a.href || "").split("#")[0];
      if (!href) continue;
      // 卡片容器：逐级向上，但一旦会包含其他商品链接或文本过长就停住，
      // 否则会把相邻商品的价格/图片误当成当前商品的
      var card = a.parentElement || a;
      for (var d = 0; d < 3 && card.parentElement; d++) {
        var next = card.parentElement;
        var links = next.querySelectorAll('a[href*="/ip/"]');
        if (links.length > 1) break;
        var nt = (next.innerText || "");
        if (nt.length > 500) break;
        card = next;
      }
      var name = (a.getAttribute("aria-label") || a.innerText || "").trim();
      if (name.length < 6) { var im = card.querySelector("img"); name = im ? (im.alt || "").trim() : ""; }
      if (name.length < 6) continue;
      var price = priceFromCard(card);
      var img = card.querySelector("img");
      items.push({
        url: href,
        title: name,
        price: price,
        image: img ? (img.currentSrc || img.src || "") : "",
        // 星级右边那个数字（★★★★★ 6754）。取不到就是 null，前端显示「—」
        sales: salesFromCard(card),
      });
    }
    if (items.length < 3) return false;
    fetch(BASE.replace(/\\/collect$/, "/collect-list"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: ch, listUrl: url, items: items }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          toast("已采集本页 " + d.data.inserted + " 个商品。回到系统即可查看。", true);
        } else {
          toast("采集失败：" + ((d && d.error && d.error.message) || "未知错误"), false);
        }
      })
      .catch(function () { toast("连不上选品系统，请确认本地服务已启动：" + BASE, false); });
    return true;
  }
  if (collectList()) return;

  /* ---------- 商品详情页：采集单个 ---------- */
  var ld = null;
  var scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (var i = 0; i < scripts.length; i++) {
    try { var parsed = JSON.parse(scripts[i].textContent); var p = findProduct(parsed); if (p) { ld = p; break; } } catch (e) {}
  }
  var name = (ld && ld.name) || attr('meta[property="og:title"]', "content") || (document.title || "").trim();
  var image = "";
  if (ld && ld.image) { image = typeof ld.image === "string" ? ld.image : (ld.image.url || (Array.isArray(ld.image) ? ld.image[0] : "")); }
  if (!image) image = attr('meta[property="og:image"]', "content");
  var price = null;
  try {
    var off = ld && (ld.offers || (ld.offers && ld.offers.offers));
    if (off) { var o = Array.isArray(off) ? off[0] : off; price = o.price !== undefined ? o.price : null; }
  } catch (e) {}
  if (price === null || price === undefined || price === "") {
    var ip = document.querySelector('[itemprop="price"]');
    if (ip) price = ip.getAttribute("content") || ip.textContent.trim();
  }
  if (price === null || price === undefined || price === "") {
    // 详情页的价格同样是拆分结构，走共用解析
    price = priceFromCard(document.body || document.documentElement);
  }
  var category = (ld && (ld.category || ld.productCategory)) || "";
  // 销量 / 评价数：详情页 JSON-LD 里的 aggregateRating.reviewCount
  // （不要取 ratingValue —— 那是星级不是数量）
  var sales = null;
  try {
    var agg = ld && (ld.aggregateRating || ld.rating);
    if (agg) { sales = agg.reviewCount !== undefined ? agg.reviewCount : (agg.ratingCount !== undefined ? agg.ratingCount : agg.count); }
  } catch (e) {}
  if (sales === null || sales === undefined || sales === "") {
    sales = salesFromCard(document.querySelector("main") || document.body || document.documentElement);
  }
  var payload = { channel: ch, url: url, jsonld: ld, title: name, image: image, price: price, category: typeof category === "object" ? "" : String(category || ""), sales: sales };
  fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.ok) {
        var name2 = (d.data && d.data.product && d.data.product.productName) || "商品";
        toast("已采集到选品系统：" + name2, true);
      } else {
        toast("采集失败：" + ((d && d.error && d.error.message) || "未知错误"), false);
      }
    })
    .catch(function (e) {
      toast("连不上选品系统，请确认本地服务已启动：" + BASE, false);
    });
})();`;

/** 生成书签链接；base 为采集接口完整地址 */
export function buildBookmarklet(base, defaultChannel = "samsclub") {
  return BOOKMARKLET_TEMPLATE(base, defaultChannel);
}
