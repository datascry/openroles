import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpClient } from "../http.ts";
import { RobotsTxtCache } from "../robots.ts";
import { parseCollInfo, resolveAllSnapshots, resolveLatestSnapshots } from "./snapshots.ts";

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

describe("resolveAllSnapshots", () => {
  const FIXTURE = JSON.stringify([
    { id: "CC-MAIN-2008-30" },
    { id: "CC-MAIN-2014-15" },
    { id: "CC-MAIN-2020-29" },
    { id: "CC-MAIN-2026-13" },
  ]);

  it("returns every snapshot when no sinceYear filter is passed", async () => {
    const fetchFn = mock(async () => new Response(FIXTURE, { status: 200 }));
    const ids = await resolveAllSnapshots(clientWith(fetchFn));
    expect(ids).toEqual(["2026-13", "2020-29", "2014-15", "2008-30"]);
  });

  it("filters to snapshots whose year is >= sinceYear", async () => {
    const fetchFn = mock(async () => new Response(FIXTURE, { status: 200 }));
    const ids = await resolveAllSnapshots(clientWith(fetchFn), 2020);
    expect(ids).toEqual(["2026-13", "2020-29"]);
  });

  it("returns [] when sinceYear excludes everything", async () => {
    const fetchFn = mock(async () => new Response(FIXTURE, { status: 200 }));
    const ids = await resolveAllSnapshots(clientWith(fetchFn), 2099);
    expect(ids).toEqual([]);
  });

  describe("collinfo cache", () => {
    const FIXTURE = JSON.stringify([{ id: "CC-MAIN-2026-13" }, { id: "CC-MAIN-2025-50" }]);

    it("writes the response to the cache directory on first fetch", async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "openroles-collinfo-"));
      let calls = 0;
      const fetchFn = mock(async () => {
        calls += 1;
        return new Response(FIXTURE, { status: 200 });
      });
      const ids = await resolveAllSnapshots(clientWith(fetchFn), undefined, { cacheDir });
      expect(ids).toEqual(["2026-13", "2025-50"]);
      expect(calls).toBe(1);
      const cached = readFileSync(join(cacheDir, "_collinfo.json"), "utf8");
      expect(JSON.parse(cached)).toHaveLength(2);
    });

    it("uses the cached body on subsequent calls within the TTL", async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "openroles-collinfo-"));
      writeFileSync(join(cacheDir, "_collinfo.json"), FIXTURE);
      let calls = 0;
      const fetchFn = mock(async () => {
        calls += 1;
        return new Response("[]", { status: 200 });
      });
      const ids = await resolveAllSnapshots(clientWith(fetchFn), undefined, {
        cacheDir,
        now: () => Date.now(),
      });
      expect(ids).toEqual(["2026-13", "2025-50"]);
      // No network call — the cache satisfied the read.
      expect(calls).toBe(0);
    });

    it("falls back to a stale cache if the network request fails", async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "openroles-collinfo-"));
      writeFileSync(join(cacheDir, "_collinfo.json"), FIXTURE);
      const fetchFn = mock(async () => {
        throw new Error("EHOSTUNREACH simulated");
      });
      // now() ahead of file mtime by > 24h forces the fetch path; the
      // simulated network failure then triggers the stale-cache fallback.
      const ids = await resolveAllSnapshots(clientWith(fetchFn), undefined, {
        cacheDir,
        now: () => Date.now() + 48 * 60 * 60 * 1000,
      });
      expect(ids).toEqual(["2026-13", "2025-50"]);
    });

    it("propagates the network error when there is no cache to fall back to", async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "openroles-collinfo-"));
      const fetchFn = mock(async () => {
        throw new Error("EHOSTUNREACH simulated");
      });
      await expect(
        resolveAllSnapshots(clientWith(fetchFn), undefined, { cacheDir }),
      ).rejects.toThrow(/EHOSTUNREACH/);
    });
  });
});
