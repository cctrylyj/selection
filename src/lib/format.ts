const SYMBOLS: Record<string, string> = {
  USD: "$",
  CNY: "¥",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

/**
 * 币种符号（USD → $、CNY → ¥）。表里没有的币种返回空串，
 * 由调用方退回「19.98 AUD」这种带代码的写法。
 *
 * 单独导出这个函数是为了让 Excel 导出复用同一份映射：
 * 导出的价格单位必须和页面上看到的完全一致，不能各写一套。
 */
export function currencySymbol(currency = "USD"): string {
  return SYMBOLS[(currency || "USD").toUpperCase()] ?? "";
}

/**
 * 价格展示：金额符号跟在数字后面（用户 2026-10-16 明确要求「价格单位放在后面」）。
 *   19.98$ / 199.00¥ / 12.34€
 * 拿不到符号（币种表里没有）时退回三位币种代码，代码后面补一个空格更好认：
 *   19.98 AUD
 */
export function formatPrice(price: number | null, currency = "USD"): string {
  if (price === null || price === undefined || Number.isNaN(Number(price))) return "—";
  const cur = (currency || "USD").toUpperCase();
  const amount = Number(price).toFixed(2);
  const sym = currencySymbol(cur);
  return sym ? `${amount}${sym}` : `${amount} ${cur}`;
}

export function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 销量 / 评价数展示：千分位分组（6754 → 6,754）。
 * 取不到返回「—」，不要显示 0（0 会被误读成「真的没人买」）。
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const n = Math.max(0, Math.round(Number(value)));
  return n.toLocaleString("en-US");
}
