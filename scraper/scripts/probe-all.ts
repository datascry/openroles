#!/usr/bin/env bun
// Re-probe each tenant in data/tenants/{ats}.json so transient_failure
// (the harvester's holding state when --skip-probe was used) becomes
// live or dead.
//
// Per-ATS concurrency is conservative (4) so we don't hammer any single
// vendor host. Workday and ultipro tenants are skipped — their probe
// URL needs metadata the slug alone doesn't supply.
//
// Output writes the tenants list back atomically (.tmp + rename).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ATS_IDS, type ATSId, SCHEMA_VERSION, type Tenant, TenantSchema } from "@openroles/shared";
import { z } from "zod";
import { probeMany } from "../src/harvest/probe.ts";
import { HttpClient } from "../src/http.ts";
import { RobotsTxtCache } from "../src/robots.ts";

const DATA_DIR = process.env["TENANT_DIR"] ?? "data/tenants";
const PER_ATS_CONCURRENCY = Number.parseInt(process.env["PROBE_CONCURRENCY"] ?? "4", 10);
const UA =
  process.env["UA"] ?? `openroles/${SCHEMA_VERSION} (+https://github.com/datascry/openroles)`;
// ATSes whose probe URL needs composite metadata we don't have on a
// freshly-harvested slug list — leave their tenants untouched.
const SKIP_ATSES = new Set<ATSId>(["workday", "ultipro"]);

interface SummaryRow {
  ats: ATSId;
  total: number;
  live: number;
  dead: number;
  transient: number;
  skipped: boolean;
}

async function loadTenants(path: string): Promise<Tenant[]> {
  const text = await readFile(path, "utf8");
  const raw = JSON.parse(text);
  return z.array(TenantSchema).parse(raw);
}

async function writeAtomic(path: string, value: Tenant[]): Promise<void> {
  const tmp = `${path}.tmp`;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

async function probeAts(ats: ATSId, client: HttpClient): Promise<SummaryRow> {
  const path = join(DATA_DIR, `${ats}.json`);
  let tenants: Tenant[];
  try {
    tenants = await loadTenants(path);
  } catch {
    return { ats, total: 0, live: 0, dead: 0, transient: 0, skipped: true };
  }
  if (tenants.length === 0) return { ats, total: 0, live: 0, dead: 0, transient: 0, skipped: true };
  if (SKIP_ATSES.has(ats)) {
    return {
      ats,
      total: tenants.length,
      live: 0,
      dead: 0,
      transient: tenants.length,
      skipped: true,
    };
  }
  const observedAt = new Date().toISOString();
  const slugs = tenants.map((t) => t.slug);
  console.log(`[${ats}] probing ${slugs.length} slugs...`);
  const probed = await probeMany(ats, slugs, {
    client,
    observedAt,
    concurrency: PER_ATS_CONCURRENCY,
  });
  await writeAtomic(path, probed);
  let live = 0;
  let dead = 0;
  let transient = 0;
  for (const t of probed) {
    if (t.status === "live") live += 1;
    else if (t.status === "dead") dead += 1;
    else transient += 1;
  }
  return { ats, total: probed.length, live, dead, transient, skipped: false };
}

async function main(): Promise<void> {
  const robots = new RobotsTxtCache();
  const client = new HttpClient({ userAgent: UA, robots });
  const summaries: SummaryRow[] = [];
  let totalLive = 0;
  let totalDead = 0;
  let totalTransient = 0;
  for (const ats of ATS_IDS) {
    const t0 = Date.now();
    const row = await probeAts(ats, client);
    summaries.push(row);
    totalLive += row.live;
    totalDead += row.dead;
    totalTransient += row.transient;
    const ms = Date.now() - t0;
    if (row.skipped) {
      console.log(`[${ats}] skipped (${row.total} tenants left at transient)`);
    } else {
      console.log(
        `[${ats}] live=${row.live} dead=${row.dead} transient=${row.transient} (${ms}ms)`,
      );
    }
  }
  console.log("\n=== probe summary ===");
  console.log("ats              total   live   dead trans");
  for (const r of summaries) {
    const flag = r.skipped ? " (skipped)" : "";
    console.log(
      `${r.ats.padEnd(16)} ${String(r.total).padStart(5)}  ${String(r.live).padStart(5)}  ${String(r.dead).padStart(5)}  ${String(r.transient).padStart(4)}${flag}`,
    );
  }
  console.log(`TOTAL: live=${totalLive} dead=${totalDead} transient=${totalTransient}`);
}

await main();
