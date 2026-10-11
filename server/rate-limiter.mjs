// Simple in-memory rate limiter for API endpoints
export class RateLimiter {
  constructor() {
    this.limits = new Map(); // IP -> { requests: [], resetAt: timestamp }
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Cleanup every minute
    this.cleanupInterval.unref?.();
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, limit] of this.limits) {
      if (limit.resetAt < now && limit.requests.length === 0) {
        this.limits.delete(ip);
      }
    }
  }

  check(ip, { maxRequests = 100, windowMs = 60000 } = {}) {
    const now = Date.now();
    const limit = this.limits.get(ip) || { requests: [], resetAt: now + windowMs };

    // Remove expired requests
    limit.requests = limit.requests.filter(timestamp => timestamp > now - windowMs);

    if (limit.requests.length >= maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: Math.min(...limit.requests) + windowMs
      };
    }

    limit.requests.push(now);
    limit.resetAt = now + windowMs;
    this.limits.set(ip, limit);

    return {
      allowed: true,
      remaining: maxRequests - limit.requests.length,
      resetAt: limit.resetAt
    };
  }

  close() {
    clearInterval(this.cleanupInterval);
    this.limits.clear();
  }
}
