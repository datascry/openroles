import { describe, expect, it } from "bun:test";
import {
  formatSkipSummary,
  MAX_SKIP_SAMPLES,
  partitionScrapeOutput,
  partitionTenants,
  type SkippedRow,
} from "./resilient-parse.ts";

function validTenant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ats: "greenhouse",
    slug: "acme",
    status: "live",
    last_probed_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

const HEX_ID = "a".repeat(64);

function validJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: HEX_ID,
    ats: "greenhouse",
    tenant_slug: "acme",
    source_id: "req-1",
    title: "Staff Engineer",
    company: "Acme",
    level: "staff",
    level_rank: 5,
    workplace_type: "remote",
    is_recruiter_post: false,
    first_seen_at: "2026-07-01T00:00:00Z",
    last_seen_at: "2026-07-01T00:00:00Z",
    url: "https://boards.greenhouse.io/acme/jobs/1",
    ...overrides,
  };
}

function validEnvelope(jobs: unknown[]): Record<string, unknown> {
  return {
    ats: "greenhouse",
    jobs,
    tenant_results: [],
    metrics: {
      started_at: "2026-07-01T00:00:00Z",
      finished_at: "2026-07-01T00:00:00Z",
      duration_ms: 0,
      requests_made: 0,
      requests_failed: 0,
      requests_retried: 0,
      bytes_received: 0,
    },
  };
}

describe("partitionTenants", () => {
  it("keeps all rows when every tenant is valid (no skips)", () => {
    const raw = [validTenant({ slug: "acme" }), validTenant({ slug: "globex", status: "dead" })];
    const { valid, skipped } = partitionTenants(raw);
    expect(valid.map((t) => t.slug)).toEqual(["acme", "globex"]);
    expect(skipped).toHaveLength(0);
  });

  it("drops only the invalid rows and keeps the valid ones", () => {
    const raw = [
      validTenant({ slug: "acme" }),
      validTenant({ ats: "workable", slug: "foo_bar" }), // underscore — invalid slug
      validTenant({ slug: "globex" }),
      validTenant({ ats: "ashby", slug: "kos.ai" }), // dot — invalid slug
    ];
    const { valid, skipped } = partitionTenants(raw);
    expect(valid.map((t) => t.slug)).toEqual(["acme", "globex"]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatchObject({ ats: "workable", slug: "foo_bar", field: "slug" });
    expect(skipped[1]).toMatchObject({ ats: "ashby", slug: "kos.ai", field: "slug" });
    expect(skipped[0]?.reason).toContain("slug");
  });

  it("labels a row whose ats/slug are themselves missing as '?'", () => {
    const { valid, skipped } = partitionTenants([{ status: "live" }]);
    expect(valid).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ ats: "?", slug: "?" });
  });

  it("returns a single skip when the input is not an array", () => {
    const { valid, skipped } = partitionTenants({ not: "an array" });
    expect(valid).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain("not a JSON array");
  });
});

describe("partitionScrapeOutput", () => {
  it("keeps every job when all are valid", () => {
    const raw = validEnvelope([validJob(), validJob({ id: "b".repeat(64) })]);
    const part = partitionScrapeOutput(raw);
    expect(part.output?.jobs).toHaveLength(2);
    expect(part.skipped).toHaveLength(0);
    expect(part.envelopeError).toBeUndefined();
  });

  it("drops only invalid jobs and keeps the rest", () => {
    const raw = validEnvelope([
      validJob({ id: "a".repeat(64) }),
      validJob({ id: "b".repeat(64), tenant_slug: "bad_slug" }), // underscore
      validJob({ id: "c".repeat(64) }),
    ]);
    const part = partitionScrapeOutput(raw);
    expect(part.output?.jobs.map((j) => j.id)).toEqual(["a".repeat(64), "c".repeat(64)]);
    expect(part.skipped).toHaveLength(1);
    expect(part.skipped[0]).toMatchObject({ slug: "bad_slug", field: "tenant_slug" });
  });

  it("falls back to the envelope ats when a bad job omits its own ats", () => {
    const raw = validEnvelope([{ tenant_slug: "acme" }]); // missing everything else
    const part = partitionScrapeOutput(raw);
    expect(part.output?.jobs).toHaveLength(0);
    expect(part.skipped[0]).toMatchObject({ ats: "greenhouse", slug: "acme" });
  });

  it("returns envelopeError and null output when the envelope is invalid", () => {
    const part = partitionScrapeOutput({ ats: "greenhouse" }); // no jobs/metrics/tenant_results
    expect(part.output).toBeNull();
    expect(part.skipped).toHaveLength(0);
    expect(part.envelopeError).toBeTruthy();
  });

  it("preserves the envelope's tenant_results and metrics", () => {
    const raw = validEnvelope([validJob()]);
    const part = partitionScrapeOutput(raw);
    expect(part.output?.ats).toBe("greenhouse");
    expect(part.output?.tenant_results).toEqual([]);
    expect(part.output?.metrics.duration_ms).toBe(0);
  });
});

describe("formatSkipSummary", () => {
  it("returns null when nothing was skipped", () => {
    expect(formatSkipSummary("tenant", [])).toBeNull();
  });

  it("names offenders and reports the count (singular)", () => {
    const rows: SkippedRow[] = [
      { ats: "workable", slug: "foo_bar", field: "slug", reason: "slug ..." },
    ];
    expect(formatSkipSummary("tenant", rows)).toBe(
      "build-db: skipped 1 invalid tenant row: workable/foo_bar (slug)",
    );
  });

  it("uses the plural form and joins multiple offenders", () => {
    const rows: SkippedRow[] = [
      { ats: "workable", slug: "foo_bar", field: "slug", reason: "" },
      { ats: "ashby", slug: "kos.ai", field: "slug", reason: "" },
    ];
    expect(formatSkipSummary("tenant", rows)).toBe(
      "build-db: skipped 2 invalid tenant rows: workable/foo_bar (slug), ashby/kos.ai (slug)",
    );
  });

  it("caps the sample list and reports the overflow total", () => {
    const rows: SkippedRow[] = Array.from({ length: MAX_SKIP_SAMPLES + 5 }, (_, i) => ({
      ats: "greenhouse",
      slug: `t${i}`,
      field: "slug",
      reason: "",
    }));
    const summary = formatSkipSummary("job", rows);
    expect(summary).toContain(`skipped ${MAX_SKIP_SAMPLES + 5} invalid job rows`);
    expect(summary).toContain("+5 more");
    // Only MAX_SKIP_SAMPLES offenders are named before the "+N more".
    expect(summary?.match(/greenhouse\//g)).toHaveLength(MAX_SKIP_SAMPLES);
  });
});
