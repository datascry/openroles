import { describe, expect, it } from "bun:test";
import { buildRuntimeUrls, fetchManifest } from "./manifest-runtime.ts";

const VALID_MANIFEST = {
  schema_version: "1.0.0",
  built_at: "2026-04-26T00:00:00Z",
  short_sha: "f1c50f0",
  db_filename: "jobs.f1c50f0.sqlite",
  total_rows: 4,
  ats_counts: { greenhouse: 2, lever: 1, ashby: 1, bamboohr: 0, workday: 0, icims: 0 },
  tenants_total: 3,
  tenants_live: 3,
};

function mockFetch(impl: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => impl(String(input))) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("fetchManifest", () => {
  it("parses a valid manifest and exposes the canonical fields", async () => {
    const m = await fetchManifest(
      "/openroles",
      mockFetch(() => jsonResponse(VALID_MANIFEST)),
    );
    expect(m.short_sha).toBe("f1c50f0");
    expect(m.db_filename).toBe("jobs.f1c50f0.sqlite");
    expect(m.total_rows).toBe(4);
    expect(m.tenants_total).toBe(3);
    expect(m.tenants_live).toBe(3);
  });

  it("strips a trailing slash from basePath when constructing the URL", async () => {
    let seen = "";
    await fetchManifest(
      "/openroles/",
      mockFetch((url) => {
        seen = url;
        return jsonResponse(VALID_MANIFEST);
      }),
    );
    expect(seen).toBe("/openroles/data/manifest.json");
  });

  it("throws on non-OK HTTP responses (manifest unreachable)", async () => {
    await expect(
      fetchManifest(
        "/openroles",
        mockFetch(() => new Response("nope", { status: 503 })),
      ),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("throws when the body is not a JSON object (array, null, primitives)", async () => {
    for (const body of [null, [], 7, "string", true]) {
      await expect(
        fetchManifest(
          "/openroles",
          mockFetch(() => jsonResponse(body)),
        ),
      ).rejects.toThrow(/object|string|integer/);
    }
  });

  it("rejects a non-string db_filename", async () => {
    await expect(
      fetchManifest(
        "/openroles",
        mockFetch(() => jsonResponse({ ...VALID_MANIFEST, db_filename: 42 })),
      ),
    ).rejects.toThrow(/db_filename/);
  });

  it("rejects db_filename outside the canonical jobs.{sha}.sqlite[.gz] shape", async () => {
    // Same class as the Phase 7 Markdown-injection guard: db_filename must
    // not be ../passwd.sqlite, must not contain pipes/control chars, must
    // not have a non-hex sha, etc.
    const bad = [
      "x",
      "jobs.abc.sqlite", // sha < 7 chars
      "jobs.GHIJKLM.sqlite", // non-hex
      "jobs.f1c50f0.csv",
      "jobs.f1c50f0.sqlite|inject",
      "../jobs.f1c50f0.sqlite",
      "/etc/passwd",
      "jobs.f1c50f0.sqlite\nMARKDOWN",
    ];
    for (const db_filename of bad) {
      await expect(
        fetchManifest(
          "/openroles",
          mockFetch(() => jsonResponse({ ...VALID_MANIFEST, db_filename })),
        ),
      ).rejects.toThrow(/db_filename/);
    }
  });

  it("accepts both jobs.{sha}.sqlite and jobs.{sha}.sqlite.gz", async () => {
    for (const db_filename of ["jobs.f1c50f0.sqlite", "jobs.f1c50f0.sqlite.gz"]) {
      const m = await fetchManifest(
        "/openroles",
        mockFetch(() => jsonResponse({ ...VALID_MANIFEST, db_filename })),
      );
      expect(m.db_filename).toBe(db_filename);
    }
  });

  it("rejects short_sha that is not 7-40 hex chars", async () => {
    for (const short_sha of ["", "abc", "XYZQWER", "abcdef0123456789".repeat(4)]) {
      await expect(
        fetchManifest(
          "/openroles",
          mockFetch(() => jsonResponse({ ...VALID_MANIFEST, short_sha })),
        ),
      ).rejects.toThrow(/short_sha/);
    }
  });

  it("rejects negative or non-integer numeric fields", async () => {
    for (const total_rows of [-1, 0.5, "4" as unknown as number, Number.NaN]) {
      await expect(
        fetchManifest(
          "/openroles",
          mockFetch(() => jsonResponse({ ...VALID_MANIFEST, total_rows })),
        ),
      ).rejects.toThrow(/total_rows/);
    }
  });

  it("rejects when db_filename short_sha disagrees with the short_sha field (defense in depth)", async () => {
    // Tamper guard: if a poisoned manifest sets one but not the other, the
    // mismatch is visible without trusting either field.
    await expect(
      fetchManifest(
        "/openroles",
        mockFetch(() =>
          jsonResponse({
            ...VALID_MANIFEST,
            short_sha: "f1c50f0",
            db_filename: "jobs.deadbeef.sqlite",
          }),
        ),
      ),
    ).rejects.toThrow(/short_sha/);
  });
});

describe("buildRuntimeUrls", () => {
  const M = { ...VALID_MANIFEST };

  it("constructs dbUrl, workerUrl, and wasmUrl rooted at the basePath", () => {
    const urls = buildRuntimeUrls("/openroles", M);
    expect(urls.dbUrl).toBe("/openroles/data/jobs.f1c50f0.sqlite");
    expect(urls.workerUrl).toBe("/openroles/sqlite-vfs/sqlite.worker.js");
    expect(urls.wasmUrl).toBe("/openroles/sqlite-vfs/sql-wasm.wasm");
  });

  it("strips a trailing slash from basePath so URLs are not double-slashed", () => {
    const urls = buildRuntimeUrls("/openroles/", M);
    expect(urls.dbUrl).toBe("/openroles/data/jobs.f1c50f0.sqlite");
  });

  it("strips the .gz suffix from db_filename — sql.js-httpvfs reads uncompressed", () => {
    const urls = buildRuntimeUrls("/openroles", { ...M, db_filename: "jobs.f1c50f0.sqlite.gz" });
    expect(urls.dbUrl).toBe("/openroles/data/jobs.f1c50f0.sqlite");
  });

  it("works with an empty basePath (root-relative deploy)", () => {
    const urls = buildRuntimeUrls("", M);
    expect(urls.dbUrl).toBe("/data/jobs.f1c50f0.sqlite");
    expect(urls.workerUrl).toBe("/sqlite-vfs/sqlite.worker.js");
  });
});

describe("fetchManifest — slim_index fields (Phase 14)", () => {
  it("defaults to empty slim_index_chunks for pre-1.5.0 manifests", async () => {
    const m = await fetchManifest(
      "/openroles",
      mockFetch(() => jsonResponse(VALID_MANIFEST)),
    );
    expect(m.slim_index_schema_version).toBe("0.0");
    expect(m.slim_index_total_rows).toBe(0);
    expect(m.slim_index_chunks).toEqual([]);
  });

  it("parses populated slim_index_chunks", async () => {
    const m = await fetchManifest(
      "/openroles",
      mockFetch(() =>
        jsonResponse({
          ...VALID_MANIFEST,
          slim_index_schema_version: "1.0",
          slim_index_total_rows: 4,
          slim_index_chunks: [
            {
              file: "slim/slim-0000-abcdef0123456789.json.gz",
              sha: "abcdef0123456789",
              rows: 4,
              bytes_gz: 1024,
              bytes_raw: 8192,
              posted_min: "2026-04-25T00:00:00Z",
              posted_max: "2026-04-26T00:00:00Z",
              has_null_posted: false,
            },
          ],
        }),
      ),
    );
    expect(m.slim_index_chunks).toHaveLength(1);
    expect(m.slim_index_chunks[0]?.sha).toBe("abcdef0123456789");
    expect(m.slim_index_chunks[0]?.posted_min).toBe("2026-04-25T00:00:00Z");
    expect(m.slim_index_chunks[0]?.has_null_posted).toBe(false);
  });

  it("rejects malformed chunk filenames", async () => {
    await expect(
      fetchManifest(
        "/openroles",
        mockFetch(() =>
          jsonResponse({
            ...VALID_MANIFEST,
            slim_index_chunks: [
              {
                file: "slim/wrong.json.gz",
                sha: "abcdef0123456789",
                rows: 1,
                bytes_gz: 100,
                bytes_raw: 200,
                posted_min: null,
                posted_max: null,
                has_null_posted: false,
              },
            ],
          }),
        ),
      ),
    ).rejects.toThrow(/file does not match/);
  });

  it("rejects when slim_index_chunks is not an array", async () => {
    await expect(
      fetchManifest(
        "/openroles",
        mockFetch(() =>
          jsonResponse({
            ...VALID_MANIFEST,
            slim_index_chunks: "not-an-array",
          }),
        ),
      ),
    ).rejects.toThrow(/slim_index_chunks to be an array/);
  });

  it("rejects an entry with a non-16-char sha", async () => {
    await expect(
      fetchManifest(
        "/openroles",
        mockFetch(() =>
          jsonResponse({
            ...VALID_MANIFEST,
            slim_index_chunks: [
              {
                file: "slim/slim-0000-abcdef0123456789.json.gz",
                sha: "short",
                rows: 1,
                bytes_gz: 100,
                bytes_raw: 200,
                posted_min: null,
                posted_max: null,
                has_null_posted: false,
              },
            ],
          }),
        ),
      ),
    ).rejects.toThrow(/sha must be 16/);
  });
});
