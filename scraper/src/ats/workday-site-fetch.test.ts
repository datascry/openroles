import { afterEach, describe, expect, it, mock } from "bun:test";
import { HttpClient, HttpError } from "../http.ts";
import { RobotsTxtCache } from "../robots.ts";
import { fetchWorkdaySite } from "./workday-site-fetch.ts";

afterEach(() => mock.restore());

const ROBOTS_OK = new RobotsTxtCache({
  fetchFn: async () => new Response("", { status: 404 }),
  clock: () => 0,
});

function clientWith(fetchFn: typeof globalThis.fetch): HttpClient {
  return new HttpClient({
    userAgent: "openroles/0.0.0 (+https://example.com)",
    robots: ROBOTS_OK,
    fetchFn,
    sleep: async () => {},
    random: () => 0.5,
    retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
  });
}

const HOST = "example.wd5.myworkdayjobs.com";

describe("fetchWorkdaySite", () => {
  it("fetches /robots.txt at the host and returns the parsed site", async () => {
    let probedUrl = "";
    const fetchFn = mock(async (input: Request | string) => {
      probedUrl = typeof input === "string" ? input : input.url;
      return new Response("User-agent: *\nAllow: /GOCJobs/\n", { status: 200 });
    });
    const site = await fetchWorkdaySite(HOST, clientWith(fetchFn));
    expect(site).toBe("GOCJobs");
    expect(probedUrl).toBe(`https://${HOST}/robots.txt`);
  });

  it("returns null when the robots.txt body has no extractable site", async () => {
    const fetchFn = mock(async () => new Response("User-agent: *\nDisallow: /\n", { status: 200 }));
    const site = await fetchWorkdaySite(HOST, clientWith(fetchFn));
    expect(site).toBeNull();
  });

  it("returns null when the network request fails", async () => {
    const fetchFn = mock(async () => {
      throw new Error("network down");
    });
    const site = await fetchWorkdaySite(HOST, clientWith(fetchFn));
    expect(site).toBeNull();
  });

  it("returns null when robots.txt 404s (HttpClient throws permanent)", async () => {
    const fetchFn = mock(async () => new Response("nope", { status: 404 }));
    const site = await fetchWorkdaySite(HOST, clientWith(fetchFn));
    expect(site).toBeNull();
  });

  it("rejects malformed workday hosts without dispatching", async () => {
    const fetchFn = mock(async () => new Response("Allow: /External/\n", { status: 200 }));
    const site = await fetchWorkdaySite("evil.example.com", clientWith(fetchFn));
    expect(site).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips the robots.txt allow-check (the URL we fetch IS robots.txt)", async () => {
    // robots.txt has to be reachable even when the host's robots policy
    // would otherwise disallow `/`. Without `skipRobots: true` we'd
    // bootstrap-deadlock: parsing robots.txt requires fetching robots.txt.
    const robotsBlock = new RobotsTxtCache({
      fetchFn: async () => new Response("User-agent: *\nDisallow: /\n", { status: 200 }),
      clock: () => 0,
    });
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt") && url.includes(HOST)) {
        return new Response("User-agent: *\nAllow: /Careers/\n", { status: 200 });
      }
      return new Response("blocked", { status: 403 });
    });
    const client = new HttpClient({
      userAgent: "openroles/0.0.0",
      robots: robotsBlock,
      fetchFn,
      sleep: async () => {},
      random: () => 0.5,
      retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
    });
    const site = await fetchWorkdaySite(HOST, client);
    expect(site).toBe("Careers");
  });

  it("does not throw when the body cannot be read", async () => {
    const fetchFn = mock(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body broken"));
            },
          }),
          { status: 200 },
        ),
    );
    const site = await fetchWorkdaySite(HOST, clientWith(fetchFn));
    expect(site).toBeNull();
  });

  it("propagates HttpError from the client as a null result, not a throw", async () => {
    // HttpClient throws HttpError on 4xx/5xx; we want a null fallback so
    // callers can treat 'no site discoverable' as a non-fatal probe outcome.
    const fetchFn = mock(async () => {
      throw new HttpError("transient", "boom", 503);
    });
    const site = await fetchWorkdaySite(HOST, clientWith(fetchFn));
    expect(site).toBeNull();
  });
});
