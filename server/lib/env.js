/** 环境变量读取：缺失时直接给出中文可执行提示，而不是让代码在深处崩掉。 */

export function getEnv(name, fallback = "") {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export function requireEnv(name, hint) {
  const v = getEnv(name);
  if (!v) {
    throw new ConfigError(`环境变量 ${name} 未配置`, hint);
  }
  return v;
}

/** 识别 .env.example 里的占位值，避免「看起来配了其实没配」 */
export function looksLikePlaceholder(v) {
  if (!v) return true;
  return /your[-_]|example\.com|xxx|placeholder|changeme|replace[-_]me/i.test(v);
}

export function hasEnv(name) {
  return Boolean(getEnv(name)) && !looksLikePlaceholder(getEnv(name));
}
