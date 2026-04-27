import { afterEach, describe, expect, it, mock } from "bun:test";
import { HttpClient } from "../http.ts";
import { RobotsTxtCache } from "../robots.ts";
import { parseCollInfo, resolveLatestSnapshots } from "./snapshots.ts";

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

describe("parseCollInfo", () => {
  it("returns ids sorted newest first", () => {
    const body = JSON.stringify([
      { id: "CC-MAIN-2025-26" },
      { id: "CC-MAIN-2026-13" },
      { id: "CC-MAIN-2025-50" },
    ]);
    expect(parseCollInfo(body)).toEqual(["2026-13", "2025-50", "2025-26"]);
  });

  it("ignores entries without a valid id", () => {
    const body = JSON.stringify([
      { id: "CC-MAIN-2026-13" },
      { id: "FOO" },
      { id: 42 },
      { name: "no id" },
    ]);
    expect(parseCollInfo(body)).toEqual(["2026-13"]);
  });

  it("returns [] on malformed JSON", () => {
    expect(parseCollInfo("{not json")).toEqual([]);
  });

  it("returns [] when the body is not an array", () => {
    expect(parseCollInfo(JSON.stringify({ id: "CC-MAIN-2026-13" }))).toEqual([]);
  });
});

describe("resolveLatestSnapshots", () => {
  it("fetches collinfo.json and slices to count", async () => {
    const fetchFn = mock(async () => {
      return new Response(
        JSON.stringify([
          { id: "CC-MAIN-2026-13" },
          { id: "CC-MAIN-2025-50" },
          { id: "CC-MAIN-2025-39" },
          { id: "CC-MAIN-2025-26" },
          { id: "CC-MAIN-2025-13" },
        ]),
        { status: 200 },
      );
    });
    const ids = await resolveLatestSnapshots(clientWith(fetchFn), 4);
    expect(ids).toEqual(["2026-13", "2025-50", "2025-39", "2025-26"]);
  });

  it("returns [] when count is zero (and does not fetch)", async () => {
    const fetchFn = mock(async () => new Response("[]", { status: 200 }));
    const ids = await resolveLatestSnapshots(clientWith(fetchFn), 0);
    expect(ids).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
