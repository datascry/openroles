import type { RobotsTxtCache } from "./robots.ts";

export type HttpErrorKind = "permanent" | "transient" | "auth";

export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(kind: HttpErrorKind, message: string, status?: number, cause?: unknown) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseMs: number;
  readonly maxMs: number;
}

export interface HttpMetrics {
  requestsMade: number;
  requestsFailed: number;
  requestsRetried: number;
  bytesReceived: number;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseMs: 500, maxMs: 30_000 };
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpClientOptions {
  readonly fetchFn?: typeof globalThis.fetch;
  readonly userAgent: string;
  readonly robots: RobotsTxtCache;
  readonly retry?: RetryPolicy;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface HttpRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

const HTTP_DATE_RE = /^[A-Z][a-z][a-z], \d{2} [A-Z][a-z][a-z] \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  if (HTTP_DATE_RE.test(trimmed)) {
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return null;
}

export class HttpClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly userAgent: string;
  private readonly robots: RobotsTxtCache;
  private readonly retry: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  readonly metrics: HttpMetrics = {
    requestsMade: 0,
    requestsFailed: 0,
    requestsRetried: 0,
    bytesReceived: 0,
  };

  constructor(opts: HttpClientOptions) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.userAgent = opts.userAgent;
    this.robots = opts.robots;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  async request(url: string, init: HttpRequestInit = {}): Promise<Response> {
    if (init.signal?.aborted) {
      throw new HttpError("permanent", "request cancelled by caller before dispatch");
    }
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new HttpError("permanent", `unsupported protocol: ${target.protocol}`);
    }

    const allowed = await this.robots.isAllowed(url, this.userAgent);
    if (!allowed) {
      throw new HttpError("permanent", `robots.txt disallows ${url}`);
    }

    let lastTransient: HttpError | null = null;

    for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
      if (init.signal?.aborted) {
        throw new HttpError("permanent", "request cancelled by caller mid-retry");
      }
      if (attempt > 0) this.metrics.requestsRetried += 1;
      this.metrics.requestsMade += 1;
      const result = await this.attempt(url, init).catch((err: unknown) => err);

      if (result instanceof Response) {
        this.recordBytes(result);
        if (result.status >= 200 && result.status < 400) return result;
        this.metrics.requestsFailed += 1;
        if (result.status === 401 || result.status === 403) {
          return await this.handleAuth(url, init, result);
        }
        if (result.status === 429 || result.status >= 500) {
          lastTransient = new HttpError(
            "transient",
            `HTTP ${result.status} at ${url}`,
            result.status,
          );
          if (attempt < this.retry.maxAttempts - 1) {
            await this.sleep(this.computeBackoff(attempt, result));
            continue;
          }
          throw lastTransient;
        }
        throw new HttpError("permanent", `HTTP ${result.status} at ${url}`, result.status);
      }

      this.metrics.requestsFailed += 1;
      if (isAbortError(result) && init.signal?.aborted) {
        throw new HttpError(
          "permanent",
          "request cancelled by caller mid-flight",
          undefined,
          result,
        );
      }

      lastTransient = new HttpError(
        "transient",
        result instanceof Error ? result.message : "network error",
        undefined,
        result,
      );
      if (attempt < this.retry.maxAttempts - 1) {
        await this.sleep(this.computeBackoff(attempt));
        continue;
      }
      throw lastTransient;
    }

    throw lastTransient ?? new HttpError("transient", "no attempts made");
  }

  private async handleAuth(
    url: string,
    init: HttpRequestInit,
    firstResponse: Response,
  ): Promise<Response> {
    await this.sleep(this.computeBackoff(0, firstResponse));
    if (init.signal?.aborted) {
      throw new HttpError("permanent", "request cancelled by caller during auth retry");
    }
    this.metrics.requestsRetried += 1;
    this.metrics.requestsMade += 1;
    const result = await this.attempt(url, init).catch((err: unknown) => err);
    if (result instanceof Response) {
      this.recordBytes(result);
      if (result.status >= 200 && result.status < 400) return result;
      this.metrics.requestsFailed += 1;
      if (result.status === 401 || result.status === 403) {
        throw new HttpError("auth", `HTTP ${result.status} at ${url}`, result.status);
      }
      if (result.status === 429 || result.status >= 500) {
        throw new HttpError("transient", `HTTP ${result.status} at ${url}`, result.status);
      }
      throw new HttpError("permanent", `HTTP ${result.status} at ${url}`, result.status);
    }
    this.metrics.requestsFailed += 1;
    throw new HttpError(
      "transient",
      result instanceof Error ? result.message : "network error",
      undefined,
      result,
    );
  }

  private recordBytes(res: Response): void {
    const len = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(len) && len > 0) this.metrics.bytesReceived += len;
  }

  private async attempt(url: string, init: HttpRequestInit): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal;
    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      accept: "application/json,text/xml;q=0.9,*/*;q=0.8",
      ...(init.headers ?? {}),
    };
    return await this.fetchFn(url, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal,
      redirect: "follow",
      credentials: "omit",
    });
  }

  private computeBackoff(attempt: number, res?: Response): number {
    if (res) {
      const ms = parseRetryAfter(res.headers.get("retry-after"), Date.now());
      if (ms !== null) {
        return Math.min(Math.max(ms, this.retry.baseMs), this.retry.maxMs);
      }
    }
    const exponential = this.retry.baseMs * 2 ** attempt;
    const jitter = exponential * (this.random() * 0.4 - 0.2);
    return Math.min(this.retry.maxMs, Math.max(0, Math.round(exponential + jitter)));
  }
}
