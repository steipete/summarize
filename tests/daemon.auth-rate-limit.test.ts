import { describe, expect, it } from "vitest";
import { AuthRateLimiter } from "../src/daemon/auth-rate-limit.js";

describe("AuthRateLimiter", () => {
  it("allows requests while under the failure threshold", () => {
    let now = 0;
    const limiter = new AuthRateLimiter({
      maxFailures: 3,
      lockoutMs: 1000,
      failureWindowMs: 10_000,
      now: () => now,
    });
    expect(limiter.check("1.2.3.4").allowed).toBe(true);
    expect(limiter.recordFailure("1.2.3.4").allowed).toBe(true);
    expect(limiter.recordFailure("1.2.3.4").allowed).toBe(true);
    expect(limiter.check("1.2.3.4").allowed).toBe(true);
  });

  it("locks out the client once the threshold is reached", () => {
    let now = 0;
    const limiter = new AuthRateLimiter({
      maxFailures: 3,
      lockoutMs: 5000,
      failureWindowMs: 10_000,
      now: () => now,
    });
    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    const trip = limiter.recordFailure("1.2.3.4");
    expect(trip.allowed).toBe(false);
    if (!trip.allowed) expect(trip.retryAfterSeconds).toBe(5);

    const blocked = limiter.check("1.2.3.4");
    expect(blocked.allowed).toBe(false);

    // After the lockout window elapses the client is allowed again.
    now += 5001;
    expect(limiter.check("1.2.3.4").allowed).toBe(true);
  });

  it("isolates clients from one another", () => {
    let now = 0;
    const limiter = new AuthRateLimiter({
      maxFailures: 2,
      lockoutMs: 1000,
      failureWindowMs: 10_000,
      now: () => now,
    });
    limiter.recordFailure("a");
    const a = limiter.recordFailure("a");
    expect(a.allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("clears failures on success", () => {
    let now = 0;
    const limiter = new AuthRateLimiter({
      maxFailures: 3,
      lockoutMs: 1000,
      failureWindowMs: 10_000,
      now: () => now,
    });
    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    limiter.recordSuccess("1.2.3.4");
    // Two more failures would normally trip the lockout (3 in a row); after a
    // success the counter resets, so we should still be allowed.
    expect(limiter.recordFailure("1.2.3.4").allowed).toBe(true);
    expect(limiter.recordFailure("1.2.3.4").allowed).toBe(true);
  });

  it("resets the counter once the failure window elapses", () => {
    let now = 0;
    const limiter = new AuthRateLimiter({
      maxFailures: 3,
      lockoutMs: 1000,
      failureWindowMs: 1000,
      now: () => now,
    });
    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    now += 1500;
    // Window has expired — counter restarts at 1, no lockout yet.
    expect(limiter.recordFailure("1.2.3.4").allowed).toBe(true);
  });

  it("treats null/empty client keys as un-trackable (always allowed)", () => {
    const limiter = new AuthRateLimiter({ maxFailures: 1, lockoutMs: 1000 });
    expect(limiter.recordFailure(null).allowed).toBe(true);
    expect(limiter.recordFailure("").allowed).toBe(true);
    expect(limiter.check(null).allowed).toBe(true);
  });

  it("evicts oldest entries past maxTrackedClients", () => {
    const limiter = new AuthRateLimiter({
      maxFailures: 5,
      maxTrackedClients: 2,
      lockoutMs: 1000,
      failureWindowMs: 10_000,
    });
    limiter.recordFailure("a");
    limiter.recordFailure("b");
    limiter.recordFailure("c");
    expect(limiter.size()).toBe(2);
    // "a" should have been evicted; a fresh failure on "a" starts from zero.
    expect(limiter.check("a").allowed).toBe(true);
  });
});
