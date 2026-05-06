import { describe, expect, it } from "bun:test";
import { withRetry } from "./retry.ts";

const noSleep = () => Promise.resolve();

describe("withRetry", () => {
  it("returns immediately on first-attempt success without sleeping", async () => {
    let calls = 0;
    let slept = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return 42;
      },
      {
        sleep: async (ms) => {
          slept += ms;
        },
      },
    );
    expect(result).toBe(42);
    expect(calls).toBe(1);
    expect(slept).toBe(0);
  });

  it("retries on failure and resolves once a later attempt succeeds", async () => {
    const attempts: Array<number> = [];
    const fn = async () => {
      attempts.push(attempts.length);
      if (attempts.length < 3) throw new Error("boom");
      return "ok";
    };
    const result = await withRetry(fn, { sleep: noSleep });
    expect(result).toBe("ok");
    expect(attempts.length).toBe(3);
  });

  it("propagates the last error after exhausting attempts", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error(`fail-${calls}`);
    };
    let thrown: Error | undefined;
    try {
      await withRetry(fn, { attempts: 3, sleep: noSleep });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toBe("fail-3");
    expect(calls).toBe(3);
  });

  it("respects the configured attempts count", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error("nope");
    };
    try {
      await withRetry(fn, { attempts: 5, sleep: noSleep });
    } catch {
      // expected
    }
    expect(calls).toBe(5);
  });

  it("waits the configured backoff between attempts", async () => {
    const slept: Array<number> = [];
    const fn = async () => {
      throw new Error("boom");
    };
    try {
      await withRetry(fn, {
        attempts: 4,
        backoffMs: [100, 200, 400],
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
    } catch {
      // expected
    }
    // 4 attempts → sleeps after attempts 1, 2, 3 (none after the 4th)
    expect(slept).toEqual([100, 200, 400]);
  });

  it("repeats the last backoff value when attempts > backoff length", async () => {
    const slept: Array<number> = [];
    const fn = async () => {
      throw new Error("boom");
    };
    try {
      await withRetry(fn, {
        attempts: 5,
        backoffMs: [50, 100],
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
    } catch {
      // expected
    }
    expect(slept).toEqual([50, 100, 100, 100]);
  });

  it("does not retry when shouldRetry returns false", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error("permanent");
    };
    try {
      await withRetry(fn, {
        sleep: noSleep,
        shouldRetry: () => false,
      });
    } catch {
      // expected
    }
    expect(calls).toBe(1);
  });

  it("invokes onRetry once per failed-but-retried attempt with attempt number + delay", async () => {
    const events: Array<{ attempt: number; delay: number }> = [];
    const fn = async () => {
      throw new Error("boom");
    };
    try {
      await withRetry(fn, {
        attempts: 3,
        backoffMs: [50, 200],
        sleep: noSleep,
        onRetry: (_err, attempt, nextDelayMs) => {
          events.push({ attempt, delay: nextDelayMs });
        },
      });
    } catch {
      // expected
    }
    // Two retry events fired (after attempts 1 and 2); none after the
    // last attempt because no further retry is scheduled.
    expect(events).toEqual([
      { attempt: 1, delay: 50 },
      { attempt: 2, delay: 200 },
    ]);
  });

  it("does not call onRetry on the final, exhausted attempt", async () => {
    const events: number[] = [];
    const fn = async () => {
      throw new Error("boom");
    };
    try {
      await withRetry(fn, {
        attempts: 2,
        sleep: noSleep,
        onRetry: (_err, attempt) => {
          events.push(attempt);
        },
      });
    } catch {
      // expected
    }
    expect(events).toEqual([1]);
  });

  it("uses the default setTimeout-backed sleep when none is injected", async () => {
    // No sleep injected: the production setTimeout-wrapper sleep fires
    // through the real event loop. backoffMs=[1] is positive so the
    // sleep guard `if (delay > 0)` actually invokes the wrapper, but
    // 1 ms keeps the test under ~50 ms wall time.
    let calls = 0;
    const start = Date.now();
    try {
      await withRetry(
        async () => {
          calls += 1;
          throw new Error("x");
        },
        { attempts: 2, backoffMs: [1] },
      );
    } catch {
      // expected
    }
    expect(calls).toBe(2);
    // Sanity: with 1 ms backoff the run resolves in well under a second.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("falls back to a 0ms delay when backoffMs is empty", async () => {
    const slept: number[] = [];
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error("x");
    };
    try {
      await withRetry(fn, {
        attempts: 3,
        backoffMs: [],
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
    } catch {
      // expected
    }
    // No sleep entries because the calculated delay is 0.
    expect(slept).toEqual([]);
    expect(calls).toBe(3);
  });
});
