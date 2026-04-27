import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpResponse, http, type RequestHandler } from "msw";
import { type SetupServerApi, setupServer } from "msw/node";
import { HttpClient } from "../src/http.ts";
import { RobotsTxtCache } from "../src/robots.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

export function readFixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf-8");
}

export function makeServer(...handlers: RequestHandler[]): SetupServerApi {
  return setupServer(...handlers);
}

export function clientWithRobotsAllowAll(
  opts: { fetchFn?: typeof globalThis.fetch } = {},
): HttpClient {
  const robots = new RobotsTxtCache({
    fetchFn: async () => new Response("", { status: 404 }),
    clock: () => 0,
  });
  return new HttpClient({
    userAgent: "openroles/0.0.0 (+https://example.com/contact)",
    robots,
    sleep: async () => {},
    random: () => 0.5,
    retry: { maxAttempts: 3, baseMs: 1, maxMs: 1 },
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
}

export { HttpResponse, http };
