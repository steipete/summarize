// Tiny in-memory rate limiter for failed `/v1/*` bearer-token auth.
//
// The daemon binds 127.0.0.1 (or 0.0.0.0 inside Windows containers), so the
// attack surface is local processes that don't already hold a paired token —
// but bearer-token endpoints with no lockout are still cheap to brute-force,
// so we keep a small per-IP failure counter as defense in depth.

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type AuthRateLimiterOptions = {
  /** Max consecutive failures before the IP is locked out. */
  maxFailures?: number;
  /** Lockout duration once `maxFailures` is reached. */
  lockoutMs?: number;
  /** Reset the failure counter if no failed attempts arrive within this window. */
  failureWindowMs?: number;
  /** Cap the IP table size; oldest entries are evicted past this. */
  maxTrackedClients?: number;
  /** Injected for tests. */
  now?: () => number;
};

type Entry = {
  failures: number;
  firstFailureAt: number;
  lockoutUntil: number;
};

const DEFAULTS = {
  maxFailures: 20,
  lockoutMs: 60_000,
  failureWindowMs: 60_000,
  maxTrackedClients: 1024,
};

export class AuthRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly lockoutMs: number;
  private readonly failureWindowMs: number;
  private readonly maxTrackedClients: number;
  private readonly now: () => number;

  constructor(options: AuthRateLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULTS.maxFailures;
    this.lockoutMs = options.lockoutMs ?? DEFAULTS.lockoutMs;
    this.failureWindowMs = options.failureWindowMs ?? DEFAULTS.failureWindowMs;
    this.maxTrackedClients = options.maxTrackedClients ?? DEFAULTS.maxTrackedClients;
    this.now = options.now ?? (() => Date.now());
  }

  check(clientKey: string | null | undefined): RateLimitDecision {
    if (!clientKey) return { allowed: true };
    const entry = this.entries.get(clientKey);
    if (!entry) return { allowed: true };
    const t = this.now();
    if (entry.lockoutUntil > t) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockoutUntil - t) / 1000) };
    }
    return { allowed: true };
  }

  recordFailure(clientKey: string | null | undefined): RateLimitDecision {
    if (!clientKey) return { allowed: true };
    const t = this.now();
    let entry = this.entries.get(clientKey);
    if (!entry || t - entry.firstFailureAt > this.failureWindowMs) {
      entry = { failures: 0, firstFailureAt: t, lockoutUntil: 0 };
    }
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      entry.lockoutUntil = t + this.lockoutMs;
    }
    this.entries.set(clientKey, entry);
    this.evictIfOversized();
    if (entry.lockoutUntil > t) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockoutUntil - t) / 1000) };
    }
    return { allowed: true };
  }

  recordSuccess(clientKey: string | null | undefined): void {
    if (!clientKey) return;
    this.entries.delete(clientKey);
  }

  /** Exposed for tests. */
  size(): number {
    return this.entries.size;
  }

  private evictIfOversized(): void {
    if (this.entries.size <= this.maxTrackedClients) return;
    // Map iteration is insertion order; drop the oldest until under cap.
    const overflow = this.entries.size - this.maxTrackedClients;
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (removed >= overflow) break;
      this.entries.delete(key);
      removed += 1;
    }
  }
}
