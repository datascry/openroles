#!/usr/bin/env bun
// Discover the per-tenant `site` label for every live workday tenant in
// data/tenants/workday.json by reading each host's /robots.txt. Writes
// the populated tenants file back atomically and prints summary stats.
//
// One-off dev tool. Production rediscovery runs through the regular
// reprobe pass — see `bun run reprobe --ats workday`. The reprobe path
// auto-discovers the site on the first run after a tenant has no site
// set, so this script is here for the initial backfill of the corpus
// and for ad-hoc re-runs after a known mass site rename.
//
// Usage:
//   bun run scraper/scripts/discover-workday-sites.ts
//
// Environment:
//   TENANT_DIR    Override data/tenants directory (default: data/tenants)
//   CONCURRENCY   Parallel robots.txt fetches (default: 6, max: 32)
//   UA            Override the User-Agent header
//   FORCE         Set to "1" to re-discover even tenants with site set

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSION, type Tenant, TenantSchema } from "@openroles/shared";
import pLimit from "p-limit";
import { z } from "zod";
import { fetchWorkdaySite } from "../src/ats/workday-site-fetch.ts";
import { HttpClient } from "../src/http.ts";
import { RobotsTxtCache } from "../src/robots.ts";

const DATA_DIR = process.env["TENANT_DIR"] ?? "data/tenants";
const CONCURRENCY = Math.min(
  32,
  Math.max(1, Number.parseInt(process.env["CONCURRENCY"] ?? "6", 10)),
);
const UA =
  process.env["UA"] ?? `openroles/${SCHEMA_VERSION} (+https://github.com/datascry/openroles)`;
const FORCE = process.env["FORCE"] === "1";

async function loadTenants(path: string): Promise<Tenant[]> {
  const text = await readFile(path, "utf8");
  return z.array(TenantSchema).parse(JSON.parse(text));
}

async function writeAtomic(path: string, value: Tenant[]): Promise<void> {
  const tmp = `${path}.tmp`;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

async function main(): Promise<void> {
  const path = join(DATA_DIR, "workday.json");
  const tenants = await loadTenants(path);
  const robots = new RobotsTxtCache();
  const client = new HttpClient({ userAgent: UA, robots });
  const limit = pLimit(CONCURRENCY);

  const liveTotal = tenants.filter((t) => t.status === "live").length;
  let attempted = 0;
  let discovered = 0;
  let alreadySet = 0;
  let skippedNoHost = 0;

  const next = await Promise.all(
    tenants.map((t) =>
      limit(async (): Promise<Tenant> => {
        if (t.status !== "live") return t;
        const host = t.metadata?.["host"];
        if (typeof host !== "string" || host.length === 0) {
          skippedNoHost += 1;
          return t;
        }
        const existingSite = t.metadata?.["site"];
        if (existingSite !== undefined && existingSite.length > 0 && !FORCE) {
          alreadySet += 1;
          return t;
        }
        attempted += 1;
        const site = await fetchWorkdaySite(host, client);
        if (site === null) return t;
        discovered += 1;
        return {
          ...t,
          metadata: { ...(t.metadata ?? {}), site },
        };
      }),
    ),
  );

  await writeAtomic(path, next);

  const populated = next.filter(
    (t) => t.status === "live" && typeof t.metadata?.["site"] === "string",
  ).length;
  const populatedPct = liveTotal > 0 ? Math.round((populated / liveTotal) * 100) : 0;
  console.log("\n=== workday site discovery ===");
  console.log(`tenants total:           ${tenants.length}`);
  console.log(`tenants live:            ${liveTotal}`);
  console.log(`already had site (skip): ${alreadySet}`);
  console.log(`no metadata.host (skip): ${skippedNoHost}`);
  console.log(`discovery attempts:      ${attempted}`);
  console.log(`discovered new sites:    ${discovered}`);
  console.log(
    `live tenants with site:  ${populated} / ${liveTotal} (${populatedPct}%) — acceptance: >70%`,
  );
}

await main();
