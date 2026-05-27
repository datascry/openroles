import { describe, expect, it } from "bun:test";
import { fetchManifest, parseManifest } from "./manifest-runtime.ts";

const VALID_BODY = {
  built_at: "2026-04-26T00:00:00Z",
  short_sha: "0123456",
  total_rows: 100,
  tenants_total: 10,
  tenants_live: 8,
  slim_index_schema_version: "1.0",
  slim_index_total_rows: 100,
  slim_index_chunks: [
    {
      file: "slim/slim-0000-0123456789abcdef.json.gz",
      sha: "0123456789abcdef",
      rows: 100,
      bytes_gz: 1024,
      bytes_raw: 4096,
      posted_min: "2026-04-01T00:00:00Z",
      posted_max: "2026-04-26T00:00:00Z",
      has_null_posted: false,
    },
  ],
};

describe("parseManifest", () => {
  it("accepts a well-formed slim-index manifest", () => {
    const m = parseManifest(VALID_BODY);
    expect(m.total_rows).toBe(100);
    expect(m.slim_index_total_rows).toBe(100);
    expect(m.slim_index_chunks).toHaveLength(1);
    expect(m.slim_index_chunks[0]?.sha).toBe("0123456789abcdef");
  });

  it("rejects non-object bodies", () => {
    expect(() => parseManifest(null)).toThrow();
    expect(() => parseManifest([])).toThrow();
    expect(() => parseManifest(42)).toThrow();
    expect(() => parseManifest("not json")).toThrow();
  });

  it("requires every top-level field", () => {
    for (const drop of [
      "built_at",
      "short_sha",
      "total_rows",
      "tenants_total",
      "tenants_live",
    ] as const) {
      const partial = { ...VALID_BODY };
      delete (partial as Record<string, unknown>)[drop];
      expect(() => parseManifest(partial)).toThrow();
    }
  });

  it("defaults missing slim_index_* fields rather than throwing", () => {
    const minimal = {
      built_at: "2026-04-26T00:00:00Z",
      short_sha: "0123456",
      total_rows: 0,
      tenants_total: 0,
      tenants_live: 0,
    };
    const m = parseManifest(minimal);
    expect(m.slim_index_schema_version).toBe("0.0");
    expect(m.slim_index_total_rows).toBe(0);
    expect(m.slim_index_chunks).toEqual([]);
  });

  it("exposes short_sha for use as a cache key", () => {
    expect(parseManifest(VALID_BODY).short_sha).toBe("0123456");
  });

  it("rejects malformed slim_index_chunks", () => {
    const bad = {
      ...VALID_BODY,
      slim_index_chunks: [
        {
          // file does not match the canonical shape (missing slim/ prefix)
          file: "slim-0000-0123456789abcdef.json.gz",
          sha: "0123456789abcdef",
          rows: 0,
          bytes_gz: 0,
          bytes_raw: 0,
          posted_min: null,
          posted_max: null,
          has_null_posted: false,
        },
      ],
    };
    expect(() => parseManifest(bad)).toThrow(/canonical shape/);
  });

  it("rejects a non-array slim_index_chunks", () => {
    expect(() => parseManifest({ ...VALID_BODY, slim_index_chunks: "nope" })).toThrow();
  });

  it("rejects a chunk sha of the wrong length", () => {
    const bad = {
      ...VALID_BODY,
      slim_index_chunks: [
        {
          ...VALID_BODY.slim_index_chunks[0],
          sha: "abc",
        },
      ],
    };
    expect(() => parseManifest(bad)).toThrow(/16 hex chars/);
  });
});

describe("fetchManifest", () => {
  it("fetches the manifest from {basePath}/data/manifest.json", async () => {
    let receivedUrl: string | null = null;
    const fakeFetch = ((url: string, _init?: RequestInit) => {
      receivedUrl = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(VALID_BODY),
      } as unknown as Response);
    }) as typeof fetch;

    const m = await fetchManifest("/openroles", fakeFetch);
    expect(receivedUrl).toBe("/openroles/data/manifest.json");
    expect(m.total_rows).toBe(100);
  });

  it("throws on non-2xx", async () => {
    const fakeFetch = (() =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      } as unknown as Response)) as typeof fetch;
    await expect(fetchManifest("/openroles", fakeFetch)).rejects.toThrow(/503/);
  });
});
