/**
 * Token-bucket rate limiter keyed by an arbitrary string (IP, socket id...).
 * `capacity` tokens refill continuously over `perMs` milliseconds.
 */
export class RateLimiter {
  constructor({ capacity, perMs, maxKeys = 50_000 }) {
    this.capacity = capacity;
    this.refillPerMs = capacity / perMs;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  /** Takes `cost` tokens. Returns 0 if allowed, otherwise ms until it would be. */
  take(key, cost = 1, now = Date.now()) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.prune(now, true);
      bucket = { tokens: this.capacity, at: now };
      this.buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.refillPerMs);
      bucket.at = now;
    }
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return 0;
    }
    return Math.ceil((cost - bucket.tokens) / this.refillPerMs);
  }

  /** Like take, but only reports: 0 if `cost` tokens are available now, otherwise ms until they would be. */
  peek(key, cost = 1, now = Date.now()) {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.refillPerMs);
    return tokens >= cost ? 0 : Math.ceil((cost - tokens) / this.refillPerMs);
  }

  /** Drops full buckets (or, under pressure, the oldest half). */
  prune(now = Date.now(), aggressive = false) {
    for (const [key, bucket] of this.buckets) {
      const tokens = bucket.tokens + (now - bucket.at) * this.refillPerMs;
      if (tokens >= this.capacity) this.buckets.delete(key);
    }
    if (aggressive && this.buckets.size >= this.maxKeys) {
      let drop = Math.floor(this.buckets.size / 2);
      for (const key of this.buckets.keys()) {
        if (drop-- <= 0) break;
        this.buckets.delete(key);
      }
    }
  }
}
