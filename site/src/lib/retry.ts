/**
 * Run an async function with exponential-style backoff retries.
 *
 * The default policy (3 attempts, 200 / 800 / 2000 ms gaps before the
 * 2nd / 3rd / final attempt) absorbs the kind of single-packet network
 * blips that surfaced the "COULD NOT LOAD THE JOB DATABASE" flash on
 * mobile carriers. After three failures the original error propagates
 * unchanged so the caller can decide how to surface it.
 *
 * The sleep callback is injectable so the tests can run synchronously
 * without faking timers.
 */
export interface RetryOptions {
  /** Total number of attempts (initial try + retries). Default 3. */
  readonly attempts?: number;
  /**
   * Wait (ms) between attempts. The i-th element is the gap before
   * the (i+1)-th attempt; if shorter than `attempts - 1`, the last
   * value repeats. Default `[200, 800, 2000]`.
   */
  readonly backoffMs?: ReadonlyArray<number>;
  /**
   * Predicate gating whether a thrown error should be retried. Default
   * retries every error. Returning false propagates immediately.
   */
  readonly shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Sleep implementation — exposed for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Called every time an attempt fails. Useful for diagnostics or for
   * surfacing a "still loading…" state in the UI.
   */
  readonly onRetry?: (err: unknown, attempt: number, nextDelayMs: number) => void;
}

const DEFAULT_BACKOFF = [200, 800, 2000];
/* c8 ignore next 1 — production setTimeout wrapper; tests inject a fake. */
const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  const sleep = opts.sleep ?? DEFAULT_SLEEP;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts - 1;
      if (isLast || !shouldRetry(err, i + 1)) break;
      const delay = backoffMs[i] ?? backoffMs[backoffMs.length - 1] ?? 0;
      if (opts.onRetry) opts.onRetry(err, i + 1, delay);
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastErr;
}
