import { afterEach, describe, expect, it, mock } from "bun:test";
import { HttpClient, HttpError } from "./http.ts";
import { RobotsTxtCache } from "./robots.ts";

const ROBOTS_OK = new RobotsTxtCache({
  fetchFn: async () => new Response("", { status: 404 }),
  clock: () => 0,
});

afterEach(() => mock.restore());

describe("HttpClient", () => {
  const baseOpts = {
    userAgent: "openroles/0.0.0 (+https://example.com/contact)",
    robots: ROBOTS_OK,
    sleep: async () => {},
    random: () => 0.5,
  };

  it("sends the configured User-Agent header", async () => {
    let capturedUa: string | null = null;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedUa = headers.get("user-agent");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new HttpClient({ ...baseOpts, fetchFn });
    const res = await client.request("https://api.example.com/v1/x");
    expect(res.status).toBe(200);
    expect(capturedUa).toBe("openroles/0.0.0 (+https://example.com/contact)");
  });

  it("retries on 5xx with exponential backoff", async () => {
    let attempt = 0;
    const fetchFn = mock(async () => {
      attempt += 1;
      if (attempt < 3) return new Response("err", { status: 503 });
      return new Response("ok", { status: 200 });
    });
    const sleeps: number[] = [];
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retry: { maxAttempts: 3, baseMs: 100, maxMs: 30000 },
    });
    const res = await client.request("https://api.example.com/x");
    expect(res.status).toBe(200);
    expect(attempt).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
  });

  it("honors Retry-After header on 429", async () => {
    let attempt = 0;
    const fetchFn = mock(async () => {
      attempt += 1;
      if (attempt === 1)
        return new Response("rate", { status: 429, headers: { "retry-after": "2" } });
      return new Response("ok", { status: 200 });
    });
    const sleeps: number[] = [];
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retry: { maxAttempts: 3, baseMs: 100, maxMs: 30000 },
    });
    await client.request("https://api.example.com/x");
    expect(sleeps[0]).toBe(2000);
  });

  it("clamps Retry-After to retry.maxMs", async () => {
    const fetchFn = mock(async () => {
      return new Response("rate", { status: 429, headers: { "retry-after": "9999" } });
    });
    const sleeps: number[] = [];
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retry: { maxAttempts: 2, baseMs: 100, maxMs: 5000 },
    });
    await expect(client.request("https://api.example.com/x")).rejects.toBeInstanceOf(HttpError);
    expect(sleeps[0]).toBe(5000);
  });

  it("throws permanent error on 4xx (non-429)", async () => {
    const fetchFn = mock(async () => new Response("not found", { status: 404 }));
    const client = new HttpClient({ ...baseOpts, fetchFn });
    await expect(client.request("https://api.example.com/x")).rejects.toMatchObject({
      kind: "permanent",
      status: 404,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws auth error after one soft retry on 401/403", async () => {
    const fetchFn = mock(async () => new Response("nope", { status: 403 }));
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    });
    await expect(client.request("https://api.example.com/x")).rejects.toMatchObject({
      kind: "auth",
      status: 403,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries then throws transient", async () => {
    const fetchFn = mock(async () => new Response("err", { status: 502 }));
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    });
    await expect(client.request("https://api.example.com/x")).rejects.toMatchObject({
      kind: "transient",
      status: 502,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("retries on AbortError (timeout) classified as transient", async () => {
    let attempt = 0;
    const fetchFn = mock(async () => {
      attempt += 1;
      if (attempt < 2) {
        const e = new Error("timeout");
        e.name = "AbortError";
        throw e;
      }
      return new Response("ok", { status: 200 });
    });
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    });
    const res = await client.request("https://api.example.com/x");
    expect(res.status).toBe(200);
  });

  it("throws permanent when robots.txt disallows", async () => {
    const robots = new RobotsTxtCache({
      fetchFn: async () => new Response("User-agent: *\nDisallow: /\n", { status: 200 }),
      clock: () => 0,
    });
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const client = new HttpClient({ ...baseOpts, fetchFn, robots });
    await expect(client.request("https://api.example.com/x")).rejects.toMatchObject({
      kind: "permanent",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never sends or stores cookies", async () => {
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("cookie")).toBe(false);
      return new Response("ok", {
        status: 200,
        headers: { "set-cookie": "x=1" },
      });
    });
    const client = new HttpClient({ ...baseOpts, fetchFn });
    await client.request("https://api.example.com/x");
    await client.request("https://api.example.com/x");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("forbids non-http(s) urls", async () => {
    const fetchFn = mock(async () => new Response("", { status: 200 }));
    const client = new HttpClient({ ...baseOpts, fetchFn });
    await expect(client.request("file:///etc/passwd")).rejects.toThrow();
  });

  it("attaches AbortSignal.timeout for the per-request timeout", async () => {
    let signal: AbortSignal | null = null;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? null;
      return new Response("ok", { status: 200 });
    });
    const client = new HttpClient({ ...baseOpts, fetchFn, timeoutMs: 5000 });
    await client.request("https://api.example.com/x");
    expect(signal).not.toBeNull();
  });

  it("uses real setTimeout when no sleep is injected", async () => {
    let attempt = 0;
    const fetchFn = mock(async () => {
      attempt += 1;
      if (attempt < 2) return new Response("err", { status: 503 });
      return new Response("ok", { status: 200 });
    });
    const client = new HttpClient({
      userAgent: "openroles/0.0.0",
      robots: ROBOTS_OK,
      fetchFn,
      retry: { maxAttempts: 2, baseMs: 1, maxMs: 1 },
      random: () => 0.5,
    });
    const res = await client.request("https://api.example.com/x");
    expect(res.status).toBe(200);
  });

  it("merges caller AbortSignal with the timeout signal", async () => {
    const ac = new AbortController();
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      const sig = init?.signal;
      if (sig?.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      return new Response("ok", { status: 200 });
    });
    const client = new HttpClient({ ...baseOpts, fetchFn });
    ac.abort();
    await expect(
      client.request("https://api.example.com/x", { signal: ac.signal }),
    ).rejects.toMatchObject({ kind: "permanent" });
  });

  it("classifies caller-aborted requests as permanent up-front (no retry)", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const client = new HttpClient({ ...baseOpts, fetchFn });
    await expect(
      client.request("https://api.example.com/x", { signal: ac.signal }),
    ).rejects.toMatchObject({ kind: "permanent" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("treats auth retry as separate from main retry budget", async () => {
    let attempts = 0;
    const fetchFn = mock(async () => {
      attempts += 1;
      if (attempts === 1) return new Response("err", { status: 503 });
      if (attempts === 2) return new Response("err", { status: 503 });
      if (attempts === 3) return new Response("auth", { status: 401 });
      return new Response("ok", { status: 200 });
    });
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    });
    const res = await client.request("https://api.example.com/x");
    expect(res.status).toBe(200);
    expect(attempts).toBe(4);
  });

  it("auth retry that yields a permanent 4xx is classified as permanent", async () => {
    let attempts = 0;
    const fetchFn = mock(async () => {
      attempts += 1;
      if (attempts === 1) return new Response("auth", { status: 401 });
      return new Response("nope", { status: 410 });
    });
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    });
    await expect(client.request("https://api.example.com/x")).rejects.toMatchObject({
      kind: "permanent",
    });
  });

  it("auth retry that throws network error is classified as transient", async () => {
    let attempts = 0;
    const fetchFn = mock(async () => {
      attempts += 1;
      if (attempts === 1) return new Response("auth", { status: 401 });
      throw new Error("network down");
    });
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    });
    await expect(client.request("https://api.example.com/x")).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("rejects auth retry attempted while caller signal is aborted between attempts", async () => {
    const ac = new AbortController();
    let attempts = 0;
    const fetchFn = mock(async () => {
      attempts += 1;
      if (attempts === 1) {
        ac.abort();
        return new Response("auth", { status: 401 });
      }
      return new Response("ok", { status: 200 });
    });
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    });
    await expect(
      client.request("https://api.example.com/x", { signal: ac.signal }),
    ).rejects.toMatchObject({ kind: "permanent" });
  });

  it("rejects mid-retry abort by caller signal between transient retries", async () => {
    const ac = new AbortController();
    let attempts = 0;
    const fetchFn = mock(async () => {
      attempts += 1;
      if (attempts === 1) {
        ac.abort();
        return new Response("err", { status: 503 });
      }
      return new Response("ok", { status: 200 });
    });
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    });
    await expect(
      client.request("https://api.example.com/x", { signal: ac.signal }),
    ).rejects.toMatchObject({ kind: "permanent" });
    expect(attempts).toBe(1);
  });

  it("auth retry that yields 5xx is classified as transient", async () => {
    let attempts = 0;
    const fetchFn = mock(async () => {
      attempts += 1;
      if (attempts === 1) return new Response("auth", { status: 401 });
      return new Response("err", { status: 503 });
    });
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    });
    await expect(client.request("https://api.example.com/x")).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("ignores garbage Retry-After values and falls back to exponential", async () => {
    let attempts = 0;
    const fetchFn = mock(async () => {
      attempts += 1;
      if (attempts === 1)
        return new Response("rate", { status: 429, headers: { "retry-after": "garbage99" } });
      return new Response("ok", { status: 200 });
    });
    const sleeps: number[] = [];
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retry: { maxAttempts: 2, baseMs: 100, maxMs: 30000 },
      random: () => 0.5,
    });
    await client.request("https://api.example.com/x");
    expect(sleeps[0]).toBeLessThan(1000);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it("Retry-After of 0 is clamped to retry.baseMs (no tight loop)", async () => {
    const fetchFn = mock(async () => {
      return new Response("rate", { status: 429, headers: { "retry-after": "0" } });
    });
    const sleeps: number[] = [];
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retry: { maxAttempts: 2, baseMs: 250, maxMs: 5000 },
    });
    await expect(client.request("https://api.example.com/x")).rejects.toBeInstanceOf(HttpError);
    expect(sleeps[0]).toBe(250);
  });

  it("parses HTTP-date form of Retry-After", async () => {
    let attempts = 0;
    const fetchFn = mock(async () => {
      attempts += 1;
      if (attempts === 1) {
        const future = new Date(Date.now() + 2000).toUTCString();
        return new Response("rate", { status: 429, headers: { "retry-after": future } });
      }
      return new Response("ok", { status: 200 });
    });
    const sleeps: number[] = [];
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retry: { maxAttempts: 2, baseMs: 100, maxMs: 30000 },
    });
    const res = await client.request("https://api.example.com/x");
    expect(res.status).toBe(200);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThan(5000);
  });

  it("counts requestsMade, requestsRetried, and bytesReceived", async () => {
    let attempts = 0;
    const fetchFn = mock(async () => {
      attempts += 1;
      if (attempts < 2)
        return new Response("err", { status: 503, headers: { "content-length": "3" } });
      return new Response("ok", { status: 200, headers: { "content-length": "2" } });
    });
    const client = new HttpClient({
      ...baseOpts,
      fetchFn,
      retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    });
    await client.request("https://api.example.com/x");
    expect(client.metrics.requestsMade).toBe(2);
    expect(client.metrics.requestsRetried).toBe(1);
    expect(client.metrics.requestsFailed).toBe(1);
    expect(client.metrics.bytesReceived).toBe(5);
  });
});
