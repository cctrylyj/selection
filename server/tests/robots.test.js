// 离线校验 robots.txt 解析逻辑（不需要网络）
// 运行：node server/tests/robots.test.js
import assert from "node:assert/strict";
import { parseRobots } from "../lib/robots.js";

const SAMS = `#robots.txt generated for samsclub.com
User-agent: *
Disallow: *SCDC=1*
Disallow: /*?bvroute
Disallow: /lists/
Disallow: */samsclub/0
Disallow: /checkout/
Disallow: /cart
Disallow: /search
Disallow: /pharmacy/login/
Disallow: /tracking
Disallow: /midas/
Disallow: /buy-it-again
Disallow: /account
Disallow: /orders
Disallow: /r/
Disallow: /login
Disallow: /reviews/write-review
Allow: /ads.txt
`;

const rules = parseRobots(SAMS);

const cases = [
  // 商品详情页允许
  ["/ip/member-s-mark-bath-tissue/1425143980", true],
  ["/ip/1425143980", true],
  ["/ads.txt", true],
  ["/", true],
  // 下面这些必须被拦住
  ["/search", false],
  ["/search/anything/here", false],
  ["/cart", false],
  ["/login", false],
  ["/account", false],
  ["/checkout/", false],
  ["/reviews/write-review", false],
  // 注意这个：/s?searchTerm= 并没有被 Sam's 的 robots.txt 覆盖。
  // 这正是我们不能自己构造站内搜索页 URL 的原因 —— 不去赌「刚好漏掉」的入口。
  ["/s?searchTerm=tissue", true],
];

// 复刻 isAllowed 的判定逻辑走一遍（避免测试时真的发网络请求）
function longestMatch(path) {
  let winner = null;
  let winnerLen = -1;
  const scan = (list, kind) => {
    for (const rule of list) {
      if (rule === "") continue;
      if (path.startsWith(rule) && rule.length > winnerLen) {
        winnerLen = rule.length;
        winner = kind;
      }
    }
  };
  scan(rules.allows, true);
  scan(rules.disallows, false);
  return winner;
}

for (const [path, expected] of cases) {
  const allowed = longestMatch(path) !== false;
  assert.equal(allowed, expected, `路径 ${path} 期望 ${expected ? "放行" : "拦截"}，实际 ${allowed ? "放行" : "拦截"}`);
}

// 兜底：空 robots 全放行
const empty = parseRobots("");
assert.deepEqual(empty, { allows: [], disallows: [] });

// 兜底：非 * 的 User-agent 组不应被收进来
const other = parseRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /ip/\n");
assert.deepEqual(other.disallows, []);
assert.deepEqual(other.allows, ["/ip/"]);

console.log(`robots.txt 解析测试通过：${cases.length} 个用例`);
