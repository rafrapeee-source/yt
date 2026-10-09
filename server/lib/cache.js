// Small in-memory LRU cache with per-entry TTL, plus in-flight request
// de-duplication: if two browser requests ask for the same upstream resource
// at once (e.g. the watch page and the status check), only one goes out.

class LruCache {
  constructor({ maxEntries = 500, maxBytes = Infinity } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.delete(key);
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs, size = 0) {
    this.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs, size });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.map.keys().next().value);
    }
  }

  delete(key) {
    const entry = this.map.get(key);
    if (!entry) return;
    this.bytes -= entry.size;
    this.map.delete(key);
  }
}

function memoize(cache) {
  const inflight = new Map();
  return function cached(key, ttlMs, producer) {
    const hit = cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
      try {
        const value = await producer();
        cache.set(key, value, ttlMs);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  };
}

module.exports = { LruCache, memoize };
