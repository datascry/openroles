#!/usr/bin/env bun
// Builds a deterministic fixture SQLite + manifest for e2e tests.
// Output goes to site/public/data/, matching the daily-refresh layout.
//
// Used by Playwright globalSetup so the runtime FilterTable has a real
// database to query against. Independent of any live ATS data.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Job, Tenant } from "@openroles/shared";
import { jobId, levelRank } from "@openroles/shared";
// Build-time-only imports. The script runs from bun (not the browser
// bundle), so reaching across the workspace is fine.
import { buildDb } from "../../scraper/src/db/build-db.ts";
import { emitSlimIndex } from "../../scraper/src/db/slim-index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = dirname(HERE);
// Default to public/ (where Astro picks it up at next build); override with
// FIXTURE_OUT_DIR to write directly into dist/data/ for already-built sites.
const DATA_DIR = process.env["FIXTURE_OUT_DIR"]
  ? process.env["FIXTURE_OUT_DIR"]
  : join(SITE_ROOT, "public", "data");

// 7-hex-char fixture sha (deterministic, not a real git sha) matching the
// canonical jobs.{sha}.sqlite shape required by the manifest schema.
const FIXTURE_SHA = "f1c50f0";
const BUILT_AT = "2026-04-26T00:00:00Z";

function makeJob(args: {
  ats: Job["ats"];
  tenant_slug: string;
  source_id: string;
  title: string;
  company: string;
  level: Job["level"];
  workplace_type: Job["workplace_type"];
  url: string;
  posted_at: string;
}): Job {
  const id = jobId({
    ats: args.ats,
    tenant_slug: args.tenant_slug,
    source_id: args.source_id,
    url: args.url,
  });
  return {
    id,
    ats: args.ats,
    tenant_slug: args.tenant_slug,
    source_id: args.source_id,
    title: args.title,
    company: args.company,
    description_excerpt: `Excerpt for ${args.title} at ${args.company}.`,
    level: args.level,
    level_rank: levelRank(args.level),
    workplace_type: args.workplace_type,
    is_recruiter_post: false,
    location_text: "Remote",
    location_country: null,
    location_region: null,
    compensation_min: null,
    compensation_max: null,
    compensation_currency: null,
    department: null,
    posted_at: args.posted_at,
    updated_at: args.posted_at,
    first_seen_at: args.posted_at,
    last_seen_at: args.posted_at,
    url: args.url,
  };
}

const headlineJobs: Job[] = [
  makeJob({
    ats: "greenhouse",
    tenant_slug: "stripe",
    source_id: "stripe-1",
    title: "Senior Software Engineer, Payments",
    company: "Stripe",
    level: "senior",
    workplace_type: "remote",
    url: "https://boards.greenhouse.io/stripe/jobs/1",
    posted_at: "2026-04-20T10:00:00Z",
  }),
  makeJob({
    ats: "greenhouse",
    tenant_slug: "stripe",
    source_id: "stripe-2",
    title: "Staff Software Engineer, Infrastructure",
    company: "Stripe",
    level: "staff",
    workplace_type: "hybrid",
    url: "https://boards.greenhouse.io/stripe/jobs/2",
    posted_at: "2026-04-22T10:00:00Z",
  }),
  makeJob({
    ats: "lever",
    tenant_slug: "vercel",
    source_id: "vercel-a",
    title: "Senior Frontend Engineer",
    company: "Vercel",
    level: "senior",
    workplace_type: "remote",
    url: "https://jobs.lever.co/vercel/a",
    posted_at: "2026-04-18T10:00:00Z",
  }),
  makeJob({
    ats: "ashby",
    tenant_slug: "linear",
    source_id: "linear-x",
    title: "Software Engineer, Platform",
    company: "Linear",
    level: "mid",
    workplace_type: "remote",
    url: "https://jobs.ashbyhq.com/linear/x",
    posted_at: "2026-04-15T10:00:00Z",
  }),
];

// Pad with deterministic filler jobs so the fixture has enough rows to
// exercise pagination (PAGE_SIZE = 50 in the FilterTable). Filler companies
// stay distinct from the headline jobs so e2e assertions on Stripe/Vercel/
// Linear remain unambiguous.
const FILLER_COUNT = 52;
const fillerJobs: Job[] = Array.from({ length: FILLER_COUNT }, (_, i) =>
  makeJob({
    ats: "greenhouse",
    tenant_slug: "filler",
    source_id: `filler-${i.toString().padStart(3, "0")}`,
    title: `Engineering Role ${i + 1}`,
    company: `Filler Co ${(i % 7) + 1}`,
    level: "mid",
    workplace_type: "remote",
    url: `https://boards.greenhouse.io/filler/jobs/${i + 1}`,
    posted_at: `2026-04-${(1 + (i % 14)).toString().padStart(2, "0")}T08:00:00Z`,
  }),
);

const jobs: Job[] = [...headlineJobs, ...fillerJobs];

const tenants: Tenant[] = [
  {
    ats: "greenhouse",
    slug: "stripe",
    display_name: "Stripe",
    status: "live",
    last_probed_at: BUILT_AT,
  },
  {
    ats: "lever",
    slug: "vercel",
    display_name: "Vercel",
    status: "live",
    last_probed_at: BUILT_AT,
  },
  {
    ats: "ashby",
    slug: "linear",
    display_name: "Linear",
    status: "live",
    last_probed_at: BUILT_AT,
  },
];

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const dbPath = join(DATA_DIR, `jobs.${FIXTURE_SHA}.sqlite`);
  // buildDb runs CREATE TABLE without IF NOT EXISTS; remove a prior fixture
  // so re-running this script is idempotent.
  if (existsSync(dbPath)) rmSync(dbPath);
  const { db, manifest } = buildDb(
    {
      outputs: [
        {
          ats: "greenhouse",
          jobs: jobs.filter((j) => j.ats === "greenhouse"),
          tenant_results: [],
          metrics: {
            started_at: BUILT_AT,
            finished_at: BUILT_AT,
            duration_ms: 0,
            requests_made: 0,
            requests_failed: 0,
            requests_retried: 0,
            bytes_received: 0,
          },
        },
        {
          ats: "lever",
          jobs: jobs.filter((j) => j.ats === "lever"),
          tenant_results: [],
          metrics: {
            started_at: BUILT_AT,
            finished_at: BUILT_AT,
            duration_ms: 0,
            requests_made: 0,
            requests_failed: 0,
            requests_retried: 0,
            bytes_received: 0,
          },
        },
        {
          ats: "ashby",
          jobs: jobs.filter((j) => j.ats === "ashby"),
          tenant_results: [],
          metrics: {
            started_at: BUILT_AT,
            finished_at: BUILT_AT,
            duration_ms: 0,
            requests_made: 0,
            requests_failed: 0,
            requests_retried: 0,
            bytes_received: 0,
          },
        },
      ],
      tenants,
      buildShortSha: FIXTURE_SHA,
      builtAt: BUILT_AT,
      notes: "e2e fixture",
    },
    dbPath,
  );
  // Mark one fixture row as is_stale=1 so e2e can assert on the STALE
  // badge. buildDb itself only flips is_stale via the carry-forward path
  // (specs/role-lifecycle.md); for fixture purposes we patch directly so
  // the e2e doesn't need a two-day build pipeline.
  db.exec(
    `UPDATE jobs SET is_stale = 1, last_seen_at = '2026-04-23T00:00:00Z' WHERE source_id = 'linear-x'`,
  );
  // Recount fresh / stale so the manifest stays consistent with the row state.
  const freshCount = (
    db.query("SELECT COUNT(*) AS c FROM jobs WHERE is_stale = 0").get() as {
      c: number;
    }
  ).c;
  const staleCount = (
    db.query("SELECT COUNT(*) AS c FROM jobs WHERE is_stale = 1").get() as {
      c: number;
    }
  ).c;
  // Emit the Phase-14 slim-index chunks against the fixture DB. The
  // FilterTable throws "this build did not emit a slim index" when
  // manifest.slim_index_chunks is empty, which leaves the e2e page
  // showing an error state and `data-testid="job-results"` never
  // renders. Emitting on the fixture mirrors what the production
  // build-db pipeline does so the e2e exercises the same code path
  // users hit.
  const slim = await emitSlimIndex(db, { outputDir: DATA_DIR });
  const patchedManifest = {
    ...manifest,
    ...slim.fields,
    fresh_count: freshCount,
    stale_count: staleCount,
  };
  db.close();
  writeFileSync(join(DATA_DIR, "manifest.json"), `${JSON.stringify(patchedManifest, null, 2)}\n`);
  console.log(
    `build-fixture-db: ${jobs.length} jobs → ${dbPath} (slim chunks: ${slim.chunkPaths.length})`,
  );
}

await main();
