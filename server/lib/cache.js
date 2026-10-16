/** 带 TTL 的内存缓存。用于搜索结果与 robots.txt，避免重复打外部接口。 */

export class TtlCache {
  #map = new Map();
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
  }

  get(key) {
    const hit = this.#map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expireAt) {
      this.#map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value) {
    this.#map.set(key, { value, expireAt: Date.now() + this.ttlMs });
    if (this.#map.size > 500) this.#prune();
  }

  #prune() {
    const now = Date.now();
    for (const [k, v] of this.#map) {
      if (now > v.expireAt) this.#map.delete(k);
    }
  }
}
