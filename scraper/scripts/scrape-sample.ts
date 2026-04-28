#!/usr/bin/env bun
// Run a small sample scrape against the live tenants in data/tenants/{ats}.json,
// writing one ScrapeOutput per ATS to data/scrapes/{ats}.json.
//
// Same iteration shape as scripts/probe-all.ts: pick a representative slice,
// run it, summarize. The point is to surface scraper bugs against real
// tenant payloads without spending hours on a full sweep.
//
// Tenants are filtered to status === "live" (the probe sweep verified the
// API responds). Workable + workday are skipped — workable's tenant list
// is back at transient_failure pending a successful v1 reprobe, and workday
// needs composite metadata (host + site) the slug list alone doesn't carry.
//
// Defaults to 5 tenants per ATS (env SAMPLE_SIZE) at concurrency 4 (env
// SCRAPE_CONCURRENCY) — conservative on purpose so we don't hammer any
// vendor host on a smoke test.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ATS_IDS, type ATSId, SCHEMA_VERSION, type Tenant, TenantSchema } from "@openroles/shared";
import { z } from "zod";
import { runScrape } from "../src/scrape.ts";

const TENANT_DIR = process.env["TENANT_DIR"] ?? "data/tenants";
const SCRAPE_DIR = process.env["SCRAPE_DIR"] ?? "data/scrape-outputs";
const SAMPLE_SIZE = Number.parseInt(process.env["SAMPLE_SIZE"] ?? "5", 10);
const SCRAPE_CONCURRENCY = Number.parseInt(process.env["SCRAPE_CONCURRENCY"] ?? "4", 10);
const CONTACT_URL = process.env["CONTACT_URL"] ?? "https://github.com/datascry/openroles";
const UA = process.env["UA"] ?? `openroles/${SCHEMA_VERSION} (+${CONTACT_URL})`;
// Skip ATSes whose tenant list is not in a probe-confirmed-live state.
const SKIP_ATSES = new Set<ATSId>(["workday", "ultipro"]);

interface SummaryRow {
  ats: ATSId;
  sampled: number;
  success: number;
  transient: number;
  dead: number;
  jobs: number;
  ms: number;
  skipped: boolean;
  reason?: string;
}

async function loadLive(path: string): Promise<Tenant[]> {
  const text = await readFile(path, "utf8");
  const all = z.array(TenantSchema).parse(JSON.parse(text));
  return all.filter((t) => t.status === "live");
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

async function sampleAts(ats: ATSId): Promise<SummaryRow> {
  if (SKIP_ATSES.has(ats)) {
    return {
      ats,
      sampled: 0,
      success: 0,
      transient: 0,
      dead: 0,
      jobs: 0,
      ms: 0,
      skipped: true,
      reason: "needs probe-confirmed live tenants or composite metadata",
    };
  }
  const tenantsPath = join(TENANT_DIR, `${ats}.json`);
  let live: Tenant[];
  try {
    live = await loadLive(tenantsPath);
  } catch {
    return {
      ats,
      sampled: 0,
      success: 0,
      transient: 0,
      dead: 0,
      jobs: 0,
      ms: 0,
      skipped: true,
      reason: "no tenants file",
    };
  }
  if (live.length === 0) {
    return {
      ats,
      sampled: 0,
      success: 0,
      transient: 0,
      dead: 0,
      jobs: 0,
      ms: 0,
      skipped: true,
      reason: "no live tenants",
    };
  }
  const sample = live.slice(0, SAMPLE_SIZE);
  const t0 = Date.now();
  console.log(`[${ats}] scraping ${sample.length} live tenant(s)...`);
  const out = await runScrape({
    input: {
      ats,
      tenants: sample.map((t) => ({
        slug: t.slug,
        ...(t.display_name !== undefined ? { display_name: t.display_name } : {}),
      })),
      userAgent: UA,
      contactUrl: CONTACT_URL,
      concurrency: SCRAPE_CONCURRENCY,
    },
  });
  const ms = Date.now() - t0;
  await mkdir(SCRAPE_DIR, { recursive: true });
  await writeAtomic(join(SCRAPE_DIR, `${ats}.json`), out);
  let success = 0;
  let transient = 0;
  let dead = 0;
  for (const r of out.tenant_results) {
    if (r.status === "success") success += 1;
    else if (r.status === "transient_failure") transient += 1;
    else dead += 1;
  }
  return {
    ats,
    sampled: sample.length,
    success,
    transient,
    dead,
    jobs: out.jobs.length,
    ms,
    skipped: false,
  };
}

async function main(): Promise<void> {
  const summaries: SummaryRow[] = [];
  let totalSampled = 0;
  let totalSuccess = 0;
  let totalJobs = 0;
  for (const ats of ATS_IDS) {
    const row = await sampleAts(ats);
    summaries.push(row);
    if (!row.skipped) {
      totalSampled += row.sampled;
      totalSuccess += row.success;
      totalJobs += row.jobs;
      console.log(
        `[${ats}] success=${row.success} transient=${row.transient} dead=${row.dead} jobs=${row.jobs} (${row.ms}ms)`,
      );
    } else {
      console.log(`[${ats}] skipped (${row.reason})`);
    }
  }
  console.log("\n=== scrape-sample summary ===");
  console.log("ats              sampled  ok trans dead   jobs    ms");
  for (const r of summaries) {
    if (r.skipped) {
      console.log(`${r.ats.padEnd(16)} (skipped: ${r.reason})`);
      continue;
    }
    console.log(
      `${r.ats.padEnd(16)} ${String(r.sampled).padStart(7)} ${String(r.success).padStart(3)} ${String(r.transient).padStart(5)} ${String(r.dead).padStart(4)} ${String(r.jobs).padStart(6)} ${String(r.ms).padStart(5)}`,
    );
  }
  console.log(`TOTAL: sampled=${totalSampled} success=${totalSuccess} jobs=${totalJobs}`);
}

await main();
