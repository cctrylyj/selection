/**
 * 选品系统浏览器采集脚本（Tampermonkey 用户脚本）
 *
 * 由选品系统动态生成：BASE 地址按当前服务端口自动填充。
 * 装好后，在山姆 / 亚马逊 / TikTok Shop 的商品详情页或列表页右下角
 * 会出现「采集到选品系统」浮动按钮，点击即采（也支持 Ctrl+Shift+Z）。
 *
 * 与 javascript: 书签相比的优势：
 *   - 不受目标站 CSP 对 javascript: URL 的拦截（山姆等站点会拦）
 *   - 拖进浏览器即可安装，不用手动往书签栏粘贴
 *   - 页面加载后按钮就在，不必去找书签栏
 *
 * 关键实现说明（踩过的坑）：
 *   - 必须用 @grant unsafeWindow（不能写 @grant none）。写 none 时 Tampermonkey
 *     会把脚本直接注入页面上下文，山姆这类带严格 CSP 的站点会静默拦截，表现为
 *     「脚本已启用但页面上什么都没有」。声明任意 @grant 会启用沙盒，
 *     沙盒不受页面 CSP 限制。
 *   - 山姆是 SPA，客户端路由切换 / React 重渲染会把我们挂的按钮删掉，
 *     所以这里用 MutationObserver + 定时补挂，而不是只挂一次。
 *   - 还要在标签页标题前面打一个「采集器✓」标记：Tampermonkey 被浏览器策略
 *     拦住时（Chrome 138+ 必须打开扩展的「允许用户脚本」开关，低版本要开
 *     开发者模式）脚本一行都不会执行，此时用户不开 F12 也能一眼看出来：
 *     标题没有这个标记 = 脚本根本没跑，跟页面、跟代码都无关。
 *   - 价格必须按「拆分结构」解析：山姆把 $16.87 渲染成大字整数（16）+ 小字
 *     角分（87）两个节点，有时还单独渲染一个上标 $。读容器的 textContent 会
 *     粘成 "$1687"，读第一个数字子节点又会丢掉角分。这段逻辑定义在
 *     server/services/collectorDom.js，由本文件中间的占位注释注入进来，
 *     与书签通道共用同一份实现（改一处两边同时生效）。
 */

// ==UserScript==
// @name         选品系统采集器
// @namespace    sourcing-system.local
// @version      1.3.0
// @description  在山姆/亚马逊/TikTok Shop 商品页与列表页采集商品到本地选品系统
// @match        *://*.samsclub.com/*
// @match        *://samsclub.com/*
// @match        *://*.amazon.com/*
// @match        *://amazon.com/*
// @match        *://*.tiktok.com/*
// @match        *://tiktok.com/*
// @match        *://*.ebay.com/*
// @match        *://*.walmart.com/*
// @match        *://*.target.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @updateURL    __UPDATE__
// @downloadURL  __UPDATE__
// ==/UserScript==

(function () {
  "use strict";

  var BASE = "__BASE__";
  var DEFAULT_CH = "__CHANNEL__";
  var MAX_LIST = 60;
  var VERSION = "1.3.0";
  var BTN_ID = "sourcing-collector-btn";
  var TITLE_TAG = "【采集器" + VERSION + "】";

/* __PRICE_HELPER__ */

  // 第一行就打日志：用户按 F12 → Console 就能判断脚本到底有没有被注入。
  // 看不到这行 = 脚本没跑（没刷新页面 / 扩展被拦 / Chrome 未开「允许用户脚本」）；
  // 看得到这行 = 脚本在跑，问题只可能在按钮挂载或网络。
  try {
    console.log("[选品采集器] v" + VERSION + " 已注入 → " + location.href);
  } catch (e) { /* 忽略 */ }

  /** 标签页标题打标记：不开 F12 也能确认脚本是否执行（SPA 改标题后会自动补回） */
  function markTitle() {
    try {
      var t = document.title || "";
      if (t.indexOf(TITLE_TAG) !== 0) document.title = TITLE_TAG + t;
    } catch (e) { /* 忽略 */ }
  }

  function channelOf(url) {
    if (/samsclub\.com/i.test(url)) return "samsclub";
    if (/amazon\./i.test(url)) return "amazon";
    if (/tiktok/i.test(url)) return "tiktokshop";
    return DEFAULT_CH;
  }

  function toast(msg, ok) {
    var d = document.createElement("div");
    d.style.cssText =
      "position:fixed;z-index:2147483647;top:16px;right:16px;max-width:340px;padding:10px 14px;" +
      "border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);font:13px/1.6 -apple-system," +
      "BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;" +
      "background:" + (ok ? "#16a34a" : "#dc2626") + ";color:#fff";
    d.textContent = msg;
    (document.body || document.documentElement).appendChild(d);
    setTimeout(function () { d.remove(); }, 4200);
  }

  function attr(sel, a) {
    var e = document.querySelector(sel);
    return e ? (e.getAttribute(a) || e.textContent || "").trim() : "";
  }

  function findProduct(n) {
    if (!n || typeof n !== "object") return null;
    if (Array.isArray(n)) {
      for (var i = 0; i < n.length; i++) { var r = findProduct(n[i]); if (r) return r; }
      return null;
    }
    var t = n["@type"]; var ts = Array.isArray(t) ? t : [t];
    for (var i = 0; i < ts.length; i++) {
      if (String(ts[i]).toLowerCase() === "product") return n;
    }
    var keys = Object.keys(n);
    for (var j = 0; j < keys.length; j++) { var r2 = findProduct(n[keys[j]]); if (r2) return r2; }
    return null;
  }

  /** 列表页：从每个商品卡片取字段（不去重，页面里出现几次就采几次） */
  /** 山姆列表页：商品链接是 /ip/xxx */
  function samsclubListItems() {
    var anchors = document.querySelectorAll('a[href*="/ip/"]');
    if (anchors.length < 3) return null;
    var items = [];
    for (var i = 0; i < anchors.length && items.length < MAX_LIST; i++) {
      var a = anchors[i];
      var href = (a.href || "").split("#")[0];
      if (!href) continue;
      // 卡片容器：逐级向上，但一旦会包含其他商品链接或文本过长就停住
      var card = a.parentElement || a;
      for (var d = 0; d < 3 && card.parentElement; d++) {
        var next = card.parentElement;
        if (next.querySelectorAll('a[href*="/ip/"]').length > 1) break;
        if ((next.innerText || "").length > 500) break;
        card = next;
      }
      var name = (a.getAttribute("aria-label") || a.innerText || "").trim();
      if (name.length < 6) { var im = card.querySelector("img"); name = im ? (im.alt || "").trim() : ""; }
      if (name.length < 6) continue;
      // 价格走 priceFromCard（就是本文件上方注入的那段共用代码）：
      // 它认得山姆「大字整数 + 小字角分」的拆分结构，也认得 "$19.98" 这种单节点
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
    return items.length >= 3 ? items : null;
  }

  /**
   * 亚马逊列表页：链接是 /dp/ASIN，卡片是 div[data-component-type="s-search-result"]，
   * 与山姆的 /ip/ 结构完全不同，走上方注入的 amazonListItems。
   */
  function listItems() {
    if (channelOf(location.href) === "amazon") return amazonListItems(MAX_LIST);
    return samsclubListItems();
  }

  /** 当前页是不是列表/搜索页：解析不到卡片时用它给准确提示，别硬采页面标题 */
  function isListPage() {
    var path = location.pathname + location.search;
    if (/amazon\./i.test(location.href)) return /\/s[?/]|\/b[?/]/.test(path);
    if (/samsclub\.com/i.test(location.href)) return /\/s\//.test(location.pathname);
    if (/tiktok/i.test(location.href)) return /search|category/i.test(path);
    return false;
  }

  /** 详情页：单个商品 */
  function singlePayload() {
    var url = location.href.split("#")[0];
    var ld = null;
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      try {
        var parsed = JSON.parse(scripts[i].textContent);
        var p = findProduct(parsed);
        if (p) { ld = p; break; }
      } catch (e) { /* 忽略坏块 */ }
    }
    var name = (ld && ld.name) || attr('meta[property="og:title"]', "content") || (document.title || "").trim();
    var image = "";
    if (ld && ld.image) {
      image = typeof ld.image === "string" ? ld.image : (ld.image.url || (Array.isArray(ld.image) ? ld.image[0] : ""));
    }
    if (!image) image = attr('meta[property="og:image"]', "content");
    var price = null;
    try {
      var off = ld && (ld.offers || ld.offers.offers);
      if (off) { var o = Array.isArray(off) ? off[0] : off; price = o.price !== undefined ? o.price : null; }
    } catch (e) { /* 忽略 */ }
    if (price === null || price === undefined || price === "") {
      var ip = document.querySelector('[itemprop="price"]');
      if (ip) price = ip.getAttribute("content") || ip.textContent.trim();
    }
    if (price === null || price === undefined || price === "") {
      // DOM 兜底也走 priceFromCard：详情页的价格同样是「大字整数 + 小字角分」
      // 的拆分结构，直接取 textContent 会得到 "$1687" 这种错值
      price = priceFromCard(document.body || document.documentElement);
    }
    var category = (ld && (ld.category || ld.productCategory)) || "";

    // 销量 / 评价数：详情页的 JSON-LD 里有 aggregateRating.reviewCount
    // （山姆给的是 {"ratingValue":"4.6","reviewCount":"3821"}）。
    // 注意取 reviewCount / ratingCount，不要取 ratingValue —— 那是星级不是数量。
    var sales = null;
    try {
      var agg = ld && (ld.aggregateRating || ld.rating);
      if (agg) {
        sales = agg.reviewCount !== undefined ? agg.reviewCount
          : (agg.ratingCount !== undefined ? agg.ratingCount : agg.count);
      }
    } catch (e) { /* 忽略 */ }
    if (sales === null || sales === undefined || sales === "") {
      sales = salesFromCard(document.querySelector("main") || document.body || document.documentElement);
    }

    return {
      channel: channelOf(url),
      url: url,
      jsonld: ld,
      title: name,
      image: image,
      price: price,
      category: typeof category === "object" ? "" : String(category || ""),
      sales: sales,
    };
  }

  function collect() {
    var items = listItems();
    var endpoint = items ? BASE.replace(/\/collect$/, "/collect-list") : BASE;
    var payload = items
      ? { channel: channelOf(location.href), listUrl: location.href.split("#")[0], items: items }
      : singlePayload();

    // 列表页却没解析出卡片时，绝不能退化成「把页面标题当商品」——
    // 那会往列表里塞一条 "Amazon.com: Flowers - $5 To $25" 的垃圾数据
    if (!items && isListPage()) {
      toast("这是列表页，但没解析到商品卡片：请等页面完全加载后再点，或进入商品详情页采集", false);
      return;
    }

    if (!items && !payload.title) {
      toast("没能从页面解析出商品，请确认已加载完成", false);
      return;
    }

    console.log("[选品采集器] 提交到 " + endpoint, payload);
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          if (items) {
            toast("已采集本页 " + d.data.inserted + " 个商品", true);
          } else {
            var p = d.data && d.data.product;
            toast("已采集：" + ((p && p.productName) || payload.title), true);
          }
        } else {
          toast("采集失败：" + ((d && d.error && d.error.message) || "未知错误"), false);
        }
      })
      .catch(function (err) {
        console.warn("[选品采集器] 请求失败", err);
        toast("连不上选品系统，请确认本地服务已启动（" + BASE + "）", false);
      });
  }

  function mountButton() {
    if (document.getElementById(BTN_ID)) return true;
    var host = document.body || document.documentElement;
    if (!host) return false;
    var b = document.createElement("div");
    b.id = BTN_ID;
    b.textContent = "采集到选品系统";
    b.title = "点击采集当前页面的商品（快捷键 Ctrl+Shift+Z）";
    b.style.cssText =
      "position:fixed;z-index:2147483647;right:20px;bottom:20px;padding:10px 16px;border-radius:8px;" +
      "background:#1677ff;color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI'," +
      "Roboto,'PingFang SC','Microsoft YaHei',sans-serif;cursor:pointer;user-select:none;" +
      "box-shadow:0 4px 14px rgba(22,119,255,.4)";
    b.addEventListener("click", function (ev) { ev.stopPropagation(); collect(); });
    host.appendChild(b);
    markTitle();
    console.log("[选品采集器] 按钮已挂载");
    return true;
  }

  // SPA 会重渲染，按钮被删掉要能自己补回来：观察 DOM + 定时兜底
  function startKeepAlive() {
    var lastUrl = location.href;
    setInterval(function () {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log("[选品采集器] 路由变化 → " + lastUrl);
      }
      markTitle();
      mountButton();
    }, 1200);

    try {
      var pending = false;
      var mo = new MutationObserver(function () {
        if (pending || document.getElementById(BTN_ID)) return;
        pending = true;
        setTimeout(function () { pending = false; mountButton(); }, 300);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      console.warn("[选品采集器] MutationObserver 不可用，仅靠定时补挂", e);
    }

    // 快捷键兜底：万一按钮被页面样式盖住，用 Ctrl+Shift+Z 也能采
    document.addEventListener("keydown", function (e) {
      if (e.ctrlKey && e.shiftKey && (e.key === "Z" || e.key === "z")) collect();
    }, true);
  }

  markTitle();
  if (document.body) mountButton();
  document.addEventListener("DOMContentLoaded", function () { markTitle(); mountButton(); });
  window.addEventListener("load", function () { markTitle(); mountButton(); });
  startKeepAlive();

  // 5 秒后仍挂不上就说清原因，别让用户干等
  setTimeout(function () {
    if (!document.getElementById(BTN_ID)) {
      console.warn("[选品采集器] 按钮未挂载成功，document.body 是否存在：", !!document.body);
    }
  }, 5000);
})();
