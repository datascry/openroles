import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { parseRobotsTxt, RobotsTxtCache } from "./robots.ts";

describe("parseRobotsTxt", () => {
  it("returns allow-all on empty body", () => {
    const r = parseRobotsTxt("");
    expect(r.isAllowed("/anything", "openroles/0.0.0")).toBe(true);
  });

  it("parses Disallow: / for User-agent: *", () => {
    const r = parseRobotsTxt("User-agent: *\nDisallow: /\n");
    expect(r.isAllowed("/jobs", "openroles/0.0.0")).toBe(false);
  });

  it("matches the most specific UA section when present", () => {
    const body = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: openroles",
      "Disallow: /admin",
      "",
    ].join("\n");
    const r = parseRobotsTxt(body);
    expect(r.isAllowed("/jobs", "openroles/0.0.0 (+https://example.com)")).toBe(true);
    expect(r.isAllowed("/admin/secrets", "openroles/0.0.0 (+https://example.com)")).toBe(false);
  });

  it("falls back to * section when UA has no specific rules", () => {
    const body = "User-agent: *\nDisallow: /private\n";
    const r = parseRobotsTxt(body);
    expect(r.isAllowed("/private/x", "openroles/0.0.0")).toBe(false);
    expect(r.isAllowed("/public/x", "openroles/0.0.0")).toBe(true);
  });

  it("longest-match wins; Allow beats equal-length Disallow", () => {
    const body = ["User-agent: *", "Disallow: /a/", "Allow: /a/public/", ""].join("\n");
    const r = parseRobotsTxt(body);
    expect(r.isAllowed("/a/public/page", "openroles/0.0.0")).toBe(true);
    expect(r.isAllowed("/a/private/page", "openroles/0.0.0")).toBe(false);
  });

  it("ignores blank lines and comments", () => {
    const body = "# hi\n\nUser-agent: *\n# nope\nDisallow: /x\n";
    const r = parseRobotsTxt(body);
    expect(r.isAllowed("/x/y", "openroles/0.0.0")).toBe(false);
    expect(r.isAllowed("/y", "openroles/0.0.0")).toBe(true);
  });

  it("treats unknown directives as harmless", () => {
    const body = "User-agent: *\nCrawl-delay: 5\nDisallow: /x\n";
    const r = parseRobotsTxt(body);
    expect(r.isAllowed("/y", "openroles/0.0.0")).toBe(true);
  });

  it("does not bleed rules across UA sections", () => {
    const body = [
      "User-agent: googlebot",
      "Disallow: /goog-only",
      "",
      "User-agent: openroles",
      "Disallow: /openroles-only",
      "",
    ].join("\n");
    const r = parseRobotsTxt(body);
    expect(r.isAllowed("/goog-only", "openroles/0.0.0")).toBe(true);
    expect(r.isAllowed("/openroles-only", "openroles/0.0.0")).toBe(false);
    expect(r.isAllowed("/openroles-only", "googlebot")).toBe(true);
    expect(r.isAllowed("/goog-only", "googlebot")).toBe(false);
  });

  it("groups consecutive User-agent lines that share a rule block", () => {
    const body = ["User-agent: googlebot", "User-agent: openroles", "Disallow: /shared", ""].join(
      "\n",
    );
    const r = parseRobotsTxt(body);
    expect(r.isAllowed("/shared", "googlebot")).toBe(false);
    expect(r.isAllowed("/shared", "openroles/0.0.0")).toBe(false);
    expect(r.isAllowed("/x", "openroles/0.0.0")).toBe(true);
  });

  it("merges rules across non-adjacent groups for the same UA", () => {
    const body = [
      "User-agent: openroles",
      "Disallow: /a",
      "",
      "User-agent: googlebot",
      "Disallow: /goog",
      "",
      "User-agent: openroles",
      "Disallow: /c",
      "",
    ].join("\n");
    const r = parseRobotsTxt(body);
    expect(r.isAllowed("/a/x", "openroles/0.0.0")).toBe(false);
    expect(r.isAllowed("/c/x", "openroles/0.0.0")).toBe(false);
    expect(r.isAllowed("/b/x", "openroles/0.0.0")).toBe(true);
    expect(r.isAllowed("/goog", "openroles/0.0.0")).toBe(true);
    expect(r.isAllowed("/c/x", "googlebot")).toBe(true);
  });

  it("matches a stored UA that contains a slash to our slash-tokenized name", () => {
    const body = "User-agent: openroles/0.0.0\nDisallow: /admin\n";
    const r = parseRobotsTxt(body);
    expect(r.isAllowed("/admin/x", "openroles/0.0.0 (+https://example.com)")).toBe(false);
    expect(r.isAllowed("/public", "openroles/0.0.0 (+https://example.com)")).toBe(true);
  });

  it("case-insensitive for UA matching, exact match on path", () => {
    const body = "User-Agent: OpenRoles\nDisallow: /X\n";
    const r = parseRobotsTxt(body);
    expect(r.isAllowed("/X/y", "openroles/0.0.0")).toBe(false);
    expect(r.isAllowed("/x/y", "openroles/0.0.0")).toBe(true);
  });
});

describe("RobotsTxtCache", () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  afterEach(() => {
    mock.restore();
  });

  it("fetches robots.txt once per origin and caches the result", async () => {
    const fetchFn = mock(async (url: string) => {
      if (url === "https://api.example.com/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private\n", { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const cache = new RobotsTxtCache({ fetchFn, clock });
    expect(await cache.isAllowed("https://api.example.com/v1/x", "openroles/0.0.0")).toBe(true);
    expect(await cache.isAllowed("https://api.example.com/private", "openroles/0.0.0")).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expiry", async () => {
    const fetchFn = mock(async () => new Response("", { status: 200 }));
    const cache = new RobotsTxtCache({ fetchFn, clock, ttlMs: 1000 });
    await cache.isAllowed("https://x.test/a", "openroles/0.0.0");
    now += 1500;
    await cache.isAllowed("https://x.test/a", "openroles/0.0.0");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("treats 404 robots.txt as allow-all", async () => {
    const fetchFn = mock(async () => new Response("nope", { status: 404 }));
    const cache = new RobotsTxtCache({ fetchFn, clock });
    expect(await cache.isAllowed("https://x.test/anything", "openroles/0.0.0")).toBe(true);
  });

  it("treats 5xx robots.txt as disallow-all (fail-closed)", async () => {
    const fetchFn = mock(async () => new Response("oops", { status: 503 }));
    const cache = new RobotsTxtCache({ fetchFn, clock });
    expect(await cache.isAllowed("https://x.test/anything", "openroles/0.0.0")).toBe(false);
  });

  it("treats fetch error as disallow-all (fail-closed)", async () => {
    const fetchFn = mock(async () => {
      throw new Error("network down");
    });
    const cache = new RobotsTxtCache({ fetchFn, clock });
    expect(await cache.isAllowed("https://x.test/anything", "openroles/0.0.0")).toBe(false);
  });

  it("isolates origins (one cache entry per host:port)", async () => {
    const fetchFn = mock(async (url: string) => {
      if (url === "https://a.test/robots.txt")
        return new Response("User-agent: *\nDisallow: /x\n", { status: 200 });
      return new Response("", { status: 200 });
    });
    const cache = new RobotsTxtCache({ fetchFn, clock });
    expect(await cache.isAllowed("https://a.test/x", "openroles/0.0.0")).toBe(false);
    expect(await cache.isAllowed("https://b.test/x", "openroles/0.0.0")).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects non-http(s) urls", async () => {
    const fetchFn = mock(async () => new Response("", { status: 200 }));
    const cache = new RobotsTxtCache({ fetchFn, clock });
    await expect(cache.isAllowed("ftp://x.test/", "openroles/0.0.0")).rejects.toThrow();
  });
});
