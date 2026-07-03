#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATS_IDS,
  type ATSId,
  ATSIdSchema,
  HARVEST_STATE_SCHEMA_VERSION,
  type HarvestState,
  HarvestStateSchema,
  type Manifest,
  ManifestSchema,
  SCHEMA_VERSION,
  type ScrapeOutput,
  ScrapeOutputSchema,
  type Tenant,
  TenantSchema,
} from "@openroles/shared";
import pLimit from "p-limit";
import { z } from "zod";
import { isSafeFetchHost } from "./ats/common.ts";
import { fetchWorkdaySite } from "./ats/workday-site-fetch.ts";
import { buildDb } from "./db/build-db.ts";
import { emitSlimIndex } from "./db/slim-index.ts";
import { diskClusterIdxCache } from "./harvest/cc-s3.ts";
import { SNAPSHOT_ID_RE } from "./harvest/cdx.ts";
import { liveSlugsExcluding } from "./harvest/cross-ats-dedup.ts";
import {
  buildEnumerationSql,
  type GjobsfeedCandidate,
  mergeCandidates,
  parseDuckdbHostRows,
} from "./harvest/gjobsfeed-enumerate.ts";
import { probeMany } from "./harvest/probe.ts";
import { runHarvest } from "./harvest/runner.ts";
import { fetchSitemapSlugs, mergeSitemapSlugs, sitemapSourceFor } from "./harvest/sitemap-index.ts";
import { resolveAllSnapshots, resolveLatestSnapshots } from "./harvest/snapshots.ts";
import { HttpClient } from "./http.ts";
import { detectDeadTenants, type TenantSnapshot } from "./observability/dead-tenants.ts";
import { detectDrift, maxSeverity } from "./observability/drift.ts";
import { renderRunReport } from "./observability/run-report.ts";
import { RobotsTxtCache } from "./robots.ts";
import { runScrape } from "./scrape.ts";

/**
 * Resolve the workspace-root `data/` directory regardless of cwd.
 *
 * Bun workspace invocations (`bun run --filter @openroles/scraper harvest`)
 * change cwd to the package directory (`scraper/`), so the previous
 * `./data` default resolved to `scraper/data/` instead of the
 * workspace-root `data/` shared with the site and the rest of the
 * pipeline. This walks up from the script location until it finds the
 * `bun.lock` that marks the workspace root, then anchors `data/` there.
 *
 * Falls back to `./data` (cwd-relative) if no `bun.lock` is found,
 * which preserves test fixtures that mkdtempSync into temp dirs and
 * pass `--output-dir` explicitly anyway.
 */
function defaultOutputDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "bun.lock"))) return join(dir, "data");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  /* c8 ignore next — only reached when bun.lock is missing entirely (broken tree). */
  return resolve("./data");
}

function usage(): void {
  console.error(`
openroles-scrape — schema ${SCHEMA_VERSION}

Usage:
  openroles-scrape <command> [options]

Commands:
  scrape                   Run the ATS scrapers against a tenant list
  harvest                  Discover tenant slugs from Common Crawl (incremental-aware)
  reprobe                  Re-probe stale tenants for liveness updates
  discover-workday-sites   Backfill metadata.site for workday tenants via robots.txt
  discover-gjobsfeed       Probe candidate brands for a Google-for-Jobs RSS feed and seed gjobsfeed
  discover-sitemap         Seed tenants from a platform's public sitemap index (isolvedhire/jazzhr/hiringthing)
  enumerate-gjobsfeed-hosts  Operator-run: CC columnar-index scan → expand gjobsfeed-candidates.json
  build-db                 Build data/jobs.{sha}.sqlite from one or more scrape outputs
  report                   Print run report from data/run-report.json (Phase 7)

scrape:
  --input <path>          Path to a JSON file with a ScrapeInput body
  --output <path>         Path to write the ScrapeOutput JSON (default: stdout)

build-db:
  --input <dir>           Directory containing one ScrapeOutput JSON per ATS
  --tenants <path>        Optional path to a JSON array of Tenant records
  --output-dir <dir>      Where to write jobs.{sha}.sqlite + manifest.json (default: ./data)
  --short-sha <sha>       7-40 hex char build identifier (default: derived from BUILD_SHORT_SHA env or 'dev0001')
  --notes <text>          Free-form note recorded in the crawls table
  --previous-db <path>    Optional path to the previous build's SQLite for stale carry-forward (specs/role-lifecycle.md)
  --stale-ttl-days <n>    Days a stale row may live before it drops (default: 3, range: 1-14)

harvest:
  --ats <id>              ATS to harvest (any of: ${ATS_IDS.join(" | ")})
  --snapshots <list>      Comma-separated CC-MAIN snapshot ids (YYYY-NN). Explicit override
  --snapshots-since <yr>  Resolve every CC-MAIN snapshot from this 4-digit year onward (bootstrap mode)
  --incremental           Read --state-file, fetch collinfo.json, process only new snapshots since last run
  --state-file <path>     Per-ATS state file (default: <output-dir>/harvest-state/<ats>.json)
  --output-dir <dir>      Where to write tenants/{ats}.json (default: ./data)
  --skip-probe            Emit slugs without liveness probing (recommended for bootstrap)
  --user-agent <ua>       Override the full User-Agent string
  --contact-url <url>     Contact URL interpolated into the default User-Agent (required if --user-agent is omitted)

  Environment:
    OPENROLES_CC_BACKEND  "http" (default) | "s3". Set to "s3" to read CDX
                          via data.commoncrawl.org/cc-index/* range requests
                          instead of the throttled index.commoncrawl.org HTTP
                          API. Cluster.idx is cached at
                          <output-dir>/harvest-state/cluster-idx/<id>.idx
                          (~100 MB per collection). See specs/harvest-incremental.md.

reprobe:
  --ats <id>              ATS whose tenants to reprobe
  --max-age-days <n>      Reprobe tenants whose last_probed_at is older than this many days (default: 7)
  --batch-size <n>        Cap per-run reprobe count (default: 5000, max: 100000)
  --concurrency <n>       Override concurrent probes (1-32). Per-ATS host caps in probe.ts still apply
                          (workable=1, jobvite/smartrecruiters/ultipro=2, etc.) to avoid CDN rate-limits
  --force-rediscover      Re-discover per-ATS metadata even when already populated (currently only affects
                          workday metadata.site, which the probe pulls from /robots.txt). Use after a known
                          mass site rename; otherwise leave off so the weekly pass stays cheap.
  --output-dir <dir>      Where the existing tenants/{ats}.json lives (default: ./data)
  --user-agent <ua>       Override the full User-Agent string
  --contact-url <url>     Contact URL interpolated into the default User-Agent

report:
  --input <dir>           Directory containing manifest.json + per-ATS scrape outputs (default: ./data)
  --previous-manifest <p> Optional path to the previous build's manifest.json for drift detection
  --tenants-history <p>   Optional path to a JSON array of TenantSnapshot for dead-tenant analysis
  --consecutive-dead <n>  Number of consecutive snapshots a tenant must be dead to be reported (default: 3)
  --output <path>         Path to write the Markdown report (default: stdout)
  --fail-on <severity>    Exit non-zero when drift severity reaches this level (info | warn | error; default: error)

discover-workday-sites:
  --batch-size <n>        Cap per-run discovery count (default: 200, max: 5000). Each tenant costs one
                          robots.txt fetch against {host}; batching is the politeness control. Lower
                          this for first-time runs against a fresh IP.
  --concurrency <n>       Concurrent robots.txt fetches (1-32, default: 6). Each fetch hits a distinct
                          Workday host so per-host rate-limits don't apply, but a global concurrency
                          ceiling keeps the burst within polite limits.
  --force-rediscover      Re-fetch even for tenants whose metadata.site is already populated. Use
                          after a known mass site rename; otherwise leave off so the pass stays cheap.
  --output-dir <dir>      Where the existing tenants/workday.json lives (default: ./data)
  --user-agent <ua>       Override the full User-Agent string
  --contact-url <url>     Contact URL interpolated into the default User-Agent

  Why this exists: probe.augmentLiveMetadata only runs site discovery when the probe URL succeeds,
  but for tenants with missing metadata.site the probe falls back to /External which 404s for the
  ~99% of tenants whose real site is named something else (ATTGeneral, Comcast_Careers, etc.).
  The probe then fails and never reaches the discovery step — a deadlock. This command sidesteps
  that loop by fetching robots.txt directly and parsing the Allow / Sitemap directives.

discover-gjobsfeed:
  --input <path>          Candidate list JSON (default: <output-dir>/gjobsfeed-candidates.json).
                          Array of { slug, display_name, hosts: [host, ...] }. Each host is probed
                          at https://{host}/sitemap.xml for the Google-for-Jobs RSS signature.
  --batch-size <n>        Cap per-run probe count (default: 200, max: 5000).
  --concurrency <n>       Concurrent feed probes (1-32, default: 6).
  --output-dir <dir>      Where tenants/ + the candidate list live (default: ./data)
  --user-agent <ua>       Override the full User-Agent string
  --contact-url <url>     Contact URL interpolated into the default User-Agent

  A match is appended to tenants/gjobsfeed.json as status=transient_failure (the reprobe / scrape
  pass promotes it). Idempotent: candidates already in gjobsfeed.json are skipped. A slug already
  status=live under ANY other ATS is skipped (cross-ATS dedup guard) — build-db only de-dupes by
  exact Job.url, so the same role reachable via two adapters would otherwise double-count.

discover-sitemap:
  --ats <id>              REQUIRED. Platform whose public sitemap to read. Supported:
                          isolvedhire (1 request, ~7,176 slugs, seed net-new),
                          jazzhr (5 requests, ~7,200 slugs, liveness-truth: re-asserts live boards),
                          hiringthing (WEAK: ~2,891 gzip children, one GET each — default samples 200).
  --tenants-file <path>   Override the tenant file to merge into (default: <output-dir>/tenants/{ats}.json)
  --max <n>               Cap child sitemaps fetched (hiringthing only; default 200). Raise for a full sweep.
  --dry-run               Compute + print the summary without writing the tenant file.
  --output-dir <dir>      Where tenants/ lives (default: ./data)

  New slugs are appended as status=transient_failure (the reprobe pass validates them before they
  count as live). Existing live slugs are untouched. For jazzhr (liveness-truth), a dead/transient
  slug the sitemap re-asserts is reset for immediate re-probe. A slug already live under another ATS
  is skipped (cross-ATS dedup guard). Idempotent, deterministic. See specs/sitemap-discovery.md.

enumerate-gjobsfeed-hosts:
  --snapshots <CC-MAIN-YYYY-NN>  REQUIRED. The Common Crawl crawl to scan (latest id from
                          https://index.commoncrawl.org/collinfo.json). No default — this is a
                          paid, heavyweight (~hundreds of GB Parquet), operator-run scan and must
                          never be cron-triggered. See specs/gjobsfeed-cc-enumeration.md.
  --input <path>          Candidate list to expand (default: <output-dir>/gjobsfeed-candidates.json)
  --output-dir <dir>      Where the candidate list lives (default: ./data)

  Requires the duckdb CLI on PATH (used with httpfs to read the CC index over S3 anonymously).
  Selects DISTINCT url_host_name where url_path='/sitemap.xml', fetch_status=200, and the host is
  career-prefixed; derives a brand slug per host; merges into the candidate list (dedupe by slug,
  existing preserved). Then run discover-gjobsfeed to probe + seed.
`);
}

interface ParsedArgs {
  readonly input: string | undefined;
  readonly output: string | undefined;
  readonly outputDir: string | undefined;
  readonly tenants: string | undefined;
  readonly shortSha: string | undefined;
  readonly notes: string | undefined;
  readonly ats: string | undefined;
  readonly snapshots: string | undefined;
  readonly snapshotsSince: string | undefined;
  readonly stateFile: string | undefined;
  readonly incremental: boolean;
  readonly maxAgeDays: string | undefined;
  readonly batchSize: string | undefined;
  readonly concurrency: string | undefined;
  readonly skipProbe: boolean;
  readonly forceRediscover: boolean;
  readonly userAgent: string | undefined;
  readonly contactUrl: string | undefined;
  readonly previousManifest: string | undefined;
  readonly previousDb: string | undefined;
  readonly staleTtlDays: string | undefined;
  readonly tenantsHistory: string | undefined;
  readonly consecutiveDead: string | undefined;
  readonly failOn: string | undefined;
  readonly tenantsFile: string | undefined;
  readonly max: string | undefined;
  readonly dryRun: boolean;
  readonly help: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let input: string | undefined;
  let output: string | undefined;
  let outputDir: string | undefined;
  let tenants: string | undefined;
  let shortSha: string | undefined;
  let notes: string | undefined;
  let ats: string | undefined;
  let snapshots: string | undefined;
  let snapshotsSince: string | undefined;
  let stateFile: string | undefined;
  let incremental = false;
  let maxAgeDays: string | undefined;
  let batchSize: string | undefined;
  let concurrency: string | undefined;
  let skipProbe = false;
  let forceRediscover = false;
  let userAgent: string | undefined;
  let contactUrl: string | undefined;
  let previousManifest: string | undefined;
  let previousDb: string | undefined;
  let staleTtlDays: string | undefined;
  let tenantsHistory: string | undefined;
  let consecutiveDead: string | undefined;
  let failOn: string | undefined;
  let tenantsFile: string | undefined;
  let max: string | undefined;
  let dryRun = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--skip-probe") {
      skipProbe = true;
      continue;
    }
    if (a === "--force-rediscover") {
      forceRediscover = true;
      continue;
    }
    if (a === "--incremental") {
      incremental = true;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--input") input = argv[++i];
    else if (a === "--output") output = argv[++i];
    else if (a === "--output-dir") outputDir = argv[++i];
    else if (a === "--tenants") tenants = argv[++i];
    else if (a === "--short-sha") shortSha = argv[++i];
    else if (a === "--notes") notes = argv[++i];
    else if (a === "--ats") ats = argv[++i];
    else if (a === "--snapshots") snapshots = argv[++i];
    else if (a === "--snapshots-since") snapshotsSince = argv[++i];
    else if (a === "--state-file") stateFile = argv[++i];
    else if (a === "--max-age-days") maxAgeDays = argv[++i];
    else if (a === "--batch-size") batchSize = argv[++i];
    else if (a === "--concurrency") concurrency = argv[++i];
    else if (a === "--user-agent") userAgent = argv[++i];
    else if (a === "--contact-url") contactUrl = argv[++i];
    else if (a === "--previous-manifest") previousManifest = argv[++i];
    else if (a === "--previous-db") previousDb = argv[++i];
    else if (a === "--stale-ttl-days") staleTtlDays = argv[++i];
    else if (a === "--tenants-history") tenantsHistory = argv[++i];
    else if (a === "--consecutive-dead") consecutiveDead = argv[++i];
    else if (a === "--fail-on") failOn = argv[++i];
    else if (a === "--tenants-file") tenantsFile = argv[++i];
    else if (a === "--max") max = argv[++i];
  }
  return {
    input,
    output,
    outputDir,
    tenants,
    shortSha,
    notes,
    ats,
    snapshots,
    snapshotsSince,
    stateFile,
    incremental,
    maxAgeDays,
    batchSize,
    concurrency,
    skipProbe,
    forceRediscover,
    userAgent,
    contactUrl,
    previousManifest,
    previousDb,
    staleTtlDays,
    tenantsHistory,
    consecutiveDead,
    failOn,
    tenantsFile,
    max,
    dryRun,
    help,
  };
}

export async function runScrapeCommand(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (args.input === undefined) {
    console.error("scrape: --input <path> is required");
    return 2;
  }
  const body = await readFile(args.input, "utf8");
  const inputJson = JSON.parse(body);
  const out = await runScrape({ input: inputJson });
  const serialized = JSON.stringify(out, null, 2);
  if (args.output !== undefined) {
    await writeFile(args.output, serialized);
  } else {
    process.stdout.write(`${serialized}\n`);
  }
  return 0;
}

const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/;

async function readJsonOrThrow(path: string, context: string = "read-json"): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${context}: failed to parse ${path}: ${msg}`);
  }
}

export async function runBuildDbCommand(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (args.input === undefined) {
    console.error("build-db: --input <dir> is required");
    return 2;
  }
  const DEV_SHA = "0000000";
  const explicitSha = args.shortSha ?? process.env["BUILD_SHORT_SHA"];
  const shortSha = explicitSha ?? DEV_SHA;
  if (!SHORT_SHA_RE.test(shortSha)) {
    console.error(`build-db: --short-sha must match ${SHORT_SHA_RE.source}, got ${shortSha}`);
    return 2;
  }
  if (explicitSha === undefined) {
    console.error(
      `build-db: no --short-sha or BUILD_SHORT_SHA env set; using placeholder '${DEV_SHA}'`,
    );
  }
  const outputDir = args.outputDir ?? defaultOutputDir();
  await mkdir(outputDir, { recursive: true });

  // Tolerate per-file failures: one corrupt scrape output should not abort
  // the entire build. Audit-driven (post-Phase-10 review C2). Combined with
  // the per-job JobSchema.safeParse in each scraper, a hostile tenant can
  // not crash the daily refresh.
  const entries = (await readdir(args.input)).sort();
  const outputs: ScrapeOutput[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(args.input, name);
    const raw = await readJsonOrThrow(path, "build-db");
    const parsed = ScrapeOutputSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(
        `build-db: skipping ${name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
      );
      continue;
    }
    outputs.push(parsed.data);
  }

  let tenants: Tenant[] = [];
  if (args.tenants !== undefined) {
    tenants = z.array(TenantSchema).parse(await readJsonOrThrow(args.tenants, "build-db"));
  }

  const builtAt = new Date().toISOString();
  const dbPath = join(outputDir, `jobs.${shortSha}.sqlite`);
  const dbTmp = `${dbPath}.tmp`;
  const manifestPath = join(outputDir, "manifest.json");
  const manifestTmp = `${manifestPath}.tmp`;
  await rm(dbTmp, { force: true });
  let staleTtlDays: number | undefined;
  if (args.staleTtlDays !== undefined) {
    const parsed = Number.parseInt(args.staleTtlDays, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 14) {
      console.error(
        `build-db: --stale-ttl-days must be an integer in [1, 14], got ${args.staleTtlDays}`,
      );
      return 2;
    }
    staleTtlDays = parsed;
  }
  let manifest: ReturnType<typeof buildDb>["manifest"];
  try {
    const { db, manifest: m } = buildDb(
      {
        outputs,
        tenants,
        buildShortSha: shortSha,
        builtAt,
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        ...(args.previousDb !== undefined ? { previousDbPath: args.previousDb } : {}),
        ...(staleTtlDays !== undefined ? { staleTtlDays } : {}),
      },
      dbTmp,
    );

    // ADR-0012: emit the client-side slim index from the same DB
    // handle, BEFORE we close it — this avoids a re-open round-trip
    // and guarantees we read exactly the rows that just landed. The
    // slim-index is the SOLE runtime data path; the SQLite itself is
    // not deployed, only used in-process here to drive the JSON
    // emission and the build-time RSS feed generation.
    const slim = await emitSlimIndex(db, { outputDir });

    db.close();
    await rename(dbTmp, dbPath);

    // Augment the manifest with the slim-index chunk metadata.
    const enriched = { ...m, ...slim.fields };
    manifest = ManifestSchema.parse(enriched);
    await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(manifestTmp, manifestPath);
    /* c8 ignore next 5 — cleanup path; only reached on rare fs/rename failure mid-write. */
  } catch (err) {
    await rm(dbTmp, { force: true });
    await rm(manifestTmp, { force: true });
    throw err;
  }
  const slimSummary = manifest.slim_index_chunks.length
    ? `, slim=${manifest.slim_index_chunks.length}×~${Math.round((manifest.slim_index_chunks[0]?.bytes_gz ?? 0) / 1024)}KB`
    : "";
  console.error(
    `build-db: ${manifest.total_rows} jobs → ${dbPath} (sha=${shortSha}, tenants=${manifest.tenants_total}${slimSummary})`,
  );
  return 0;
}

export async function runHarvestCommand(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (args.ats === undefined) {
    console.error("harvest: --ats <id> is required");
    return 2;
  }
  const atsParse = ATSIdSchema.safeParse(args.ats);
  if (!atsParse.success) {
    console.error(`harvest: --ats must be one of ${ATS_IDS.join("|")}, got ${args.ats}`);
    return 2;
  }
  const ats: ATSId = atsParse.data;

  let userAgent: string;
  if (args.userAgent !== undefined) {
    userAgent = args.userAgent;
  } else if (args.contactUrl !== undefined) {
    userAgent = `openroles/${SCHEMA_VERSION} (+${args.contactUrl})`;
  } else {
    console.error(
      "harvest: --user-agent or --contact-url is required (so the receiving site can identify this bot)",
    );
    return 2;
  }
  const robots = new RobotsTxtCache();
  const client = new HttpClient({ userAgent, robots });

  // Three snapshot-selection modes, in priority order:
  //   1. Explicit --snapshots  (developer iteration, one-off slices)
  //   2. --incremental         (state-file diff; production weekly path)
  //   3. --snapshots-since YYYY (historical bootstrap)
  //   4. fallback              (latest 40, legacy behavior)
  const observedAt = new Date().toISOString();
  const outputDir = args.outputDir ?? defaultOutputDir();
  const stateFilePath = args.stateFile ?? join(outputDir, "harvest-state", `${ats}.json`);
  // Cache collinfo.json next to the state files so back-to-back per-ATS
  // bootstraps don't refetch from index.commoncrawl.org and trip its
  // per-IP rate-limit. 24h TTL inside the cache helper.
  const collInfoCache = { cacheDir: join(outputDir, "harvest-state") };
  let existingState: HarvestState | undefined;
  if (args.incremental || (await fileExists(stateFilePath))) {
    existingState = await loadHarvestState(stateFilePath, ats);
  }

  let snapshots: string[];
  if (args.snapshots !== undefined) {
    const requested = args.snapshots
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (requested.length === 0) {
      console.error("harvest: --snapshots must contain at least one snapshot id");
      return 2;
    }
    const bad = requested.find((s) => !SNAPSHOT_ID_RE.test(s));
    if (bad !== undefined) {
      console.error(`harvest: --snapshots ids must match YYYY-NN, got ${bad}`);
      return 2;
    }
    snapshots = requested;
  } else if (args.incremental) {
    if (existingState === undefined) {
      console.error(
        `harvest: --incremental requires an existing state file at ${stateFilePath}; run a bootstrap pass first`,
      );
      return 2;
    }
    const all = await resolveAllSnapshots(client, undefined, collInfoCache);
    /* c8 ignore next 4 — defensive: only fires if collinfo.json returns empty, which would also break the legacy resolveLatestSnapshots path. */
    if (all.length === 0) {
      console.error("harvest: failed to resolve CC-MAIN snapshots from collinfo.json");
      return 2;
    }
    const processed = new Set(existingState.snapshots_processed);
    snapshots = all.filter((s) => !processed.has(s));
    if (snapshots.length === 0) {
      console.error(
        `harvest: ${ats} → no new snapshots since ${existingState.last_updated_at}; nothing to do`,
      );
      return 0;
    }
  } else if (args.snapshotsSince !== undefined) {
    const yr = Number.parseInt(args.snapshotsSince, 10);
    if (!Number.isFinite(yr) || yr < 2008 || yr > 2100) {
      console.error(
        `harvest: --snapshots-since must be a four-digit year >= 2008, got ${args.snapshotsSince}`,
      );
      return 2;
    }
    snapshots = await resolveAllSnapshots(client, yr, collInfoCache);
    /* c8 ignore next 4 — defensive: only fires if collinfo.json has nothing for the requested year (extreme edge). */
    if (snapshots.length === 0) {
      console.error(`harvest: collinfo.json yielded no snapshots since ${yr}`);
      return 2;
    }
  } else {
    snapshots = await resolveLatestSnapshots(client, 40, collInfoCache);
    if (snapshots.length === 0) {
      console.error("harvest: failed to resolve latest CC-MAIN snapshots; pass --snapshots");
      return 2;
    }
  }

  const tenantsDir = join(outputDir, "tenants");
  await mkdir(tenantsDir, { recursive: true });
  const path = join(tenantsDir, `${ats}.json`);
  const existingTenants = await loadTenants(path, ats);

  // Backend dispatch: OPENROLES_CC_BACKEND=s3 routes CDX fetches through
  // data.commoncrawl.org/cc-index/* instead of the throttled HTTP API at
  // index.commoncrawl.org. Cluster.idx is cached on disk per collection
  // so a 22-ATS bootstrap doesn't re-download the same 100 MB index file
  // 22 times. See scraper/src/harvest/cc-s3.ts.
  const cdxBackend = process.env["OPENROLES_CC_BACKEND"] === "s3" ? "s3" : "http";
  const clusterIdxCache =
    cdxBackend === "s3" ? diskClusterIdxCache(join(outputDir, "harvest-state")) : undefined;

  const result = await runHarvest({
    ats,
    snapshots,
    client,
    observedAt,
    cdxBackend,
    ...(clusterIdxCache ? { clusterIdxCache } : {}),
    ...(args.skipProbe ? { skipProbe: true } : {}),
    ...(existingTenants.length > 0 ? { existingTenants } : {}),
  });

  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(result.tenants, null, 2)}\n`);
    await rename(tmp, path);
    /* c8 ignore next 4 — cleanup path; only reached on rare fs/rename failure mid-write. */
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }

  // Update state file: union of previously-processed snapshots and the
  // ones we just processed, sorted ascending for deterministic diffs.
  const previousProcessed = existingState?.snapshots_processed ?? [];
  const mergedProcessed = Array.from(new Set<string>([...previousProcessed, ...snapshots])).sort();
  const newState: HarvestState = {
    schema_version: HARVEST_STATE_SCHEMA_VERSION,
    ats,
    snapshots_processed: mergedProcessed,
    tenant_count: result.tenants.length,
    last_updated_at: observedAt,
  };
  await writeHarvestState(stateFilePath, newState);

  console.error(
    `harvest: ${ats} → ${result.unique_slugs} unique slugs from ${result.cdx_records} CDX records (${result.tenants.filter((t) => t.status === "live").length} live; processed ${snapshots.length} new snapshots, ${mergedProcessed.length} total in state)`,
  );
  return 0;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function loadHarvestState(path: string, ats: ATSId): Promise<HarvestState | undefined> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error(`harvest: state file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = HarvestStateSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `harvest: state file ${path} failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  if (parsed.data.ats !== ats) {
    throw new Error(`harvest: state file ${path} is for ats=${parsed.data.ats}, expected ${ats}`);
  }
  return parsed.data;
}

async function loadTenants(path: string, ats: ATSId): Promise<Tenant[]> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const json = JSON.parse(body);
  const tenants = z.array(TenantSchema).parse(json);
  return tenants.filter((t) => t.ats === ats);
}

async function writeHarvestState(path: string, state: HarvestState): Promise<void> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, path);
    /* c8 ignore next 4 — cleanup path; only reached on rare fs/rename failure mid-write. */
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// Mass-failure guard thresholds. A healthy ATS host sheds tenants
// gradually, not in a single reprobe. When a large share of a connector's
// previously-`live` tenants flip to `dead` in one run, that's the fingerprint
// of a transient host/network incident — a brief outage whose connection
// failures HttpClient classifies as permanent. Persisting those as `dead`
// has wiped whole connectors before (workable ~4.9k live tenants flipped
// dead on 2026-04-28; breezy ~4.7k on 2026-06-04), dropping them from the
// daily scrape. Above BOTH thresholds we treat the run as a suspected
// incident and demote the live→dead transitions to `transient_failure` so
// they survive and get re-probed, rather than permanently dropping live
// tenants on the strength of one bad run.
const INCIDENT_MIN_LIVE_TO_DEAD = 50;
const INCIDENT_LIVE_TO_DEAD_FRACTION = 0.5;

/**
 * Re-probe tenants whose `last_probed_at` is older than `--max-age-days`,
 * up to `--batch-size` of them per run. Status is updated in place;
 * everything else (slug, metadata, first_seen_at) is preserved. New
 * tenants discovered by `--incremental` (status=transient_failure,
 * last_probed_at=today) are picked up by the next reprobe pass after
 * they age past the threshold. See ADR-0011.
 */
export async function runReprobeCommand(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (args.ats === undefined) {
    console.error("reprobe: --ats <id> is required");
    return 2;
  }
  const atsParse = ATSIdSchema.safeParse(args.ats);
  if (!atsParse.success) {
    console.error(`reprobe: --ats must be one of ${ATS_IDS.join("|")}, got ${args.ats}`);
    return 2;
  }
  const ats: ATSId = atsParse.data;

  let userAgent: string;
  if (args.userAgent !== undefined) {
    userAgent = args.userAgent;
  } else if (args.contactUrl !== undefined) {
    userAgent = `openroles/${SCHEMA_VERSION} (+${args.contactUrl})`;
  } else {
    console.error("reprobe: --user-agent or --contact-url is required");
    return 2;
  }

  const maxAgeDays = args.maxAgeDays !== undefined ? Number.parseInt(args.maxAgeDays, 10) : 7;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0 || maxAgeDays > 365) {
    console.error(`reprobe: --max-age-days must be in [0, 365], got ${args.maxAgeDays}`);
    return 2;
  }
  const batchSize = args.batchSize !== undefined ? Number.parseInt(args.batchSize, 10) : 5000;
  if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 100_000) {
    console.error(`reprobe: --batch-size must be in [1, 100000], got ${args.batchSize}`);
    return 2;
  }

  const outputDir = args.outputDir ?? defaultOutputDir();
  const path = join(outputDir, "tenants", `${ats}.json`);
  const tenants = await loadTenants(path, ats);
  if (tenants.length === 0) {
    console.error(`reprobe: ${ats} → no existing tenant file at ${path}; nothing to do`);
    return 0;
  }

  const observedAt = new Date().toISOString();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  // Oldest probes first — gives us deterministic, stable batching across
  // runs (a tenant probed today won't get re-probed tomorrow if there are
  // older ones still waiting).
  const stale = tenants
    .filter((t) => Date.parse(t.last_probed_at) <= cutoff)
    .sort((a, b) => Date.parse(a.last_probed_at) - Date.parse(b.last_probed_at))
    .slice(0, batchSize);
  if (stale.length === 0) {
    console.error(`reprobe: ${ats} → 0 tenants older than ${maxAgeDays} days; nothing to do`);
    return 0;
  }

  const robots = new RobotsTxtCache();
  const client = new HttpClient({ userAgent, robots });
  // Concurrent probes via probeMany — same path the harvest pipeline
  // already uses for new-slug discovery. probe.ts caps at 6 concurrent
  // by default which is gentle on shared API hosts (greenhouse, jobvite)
  // and trivially safe for per-subdomain ATSes (bamboohr, icims, etc.)
  // where every probe hits a different host.
  // Without this, a 15k-tenant reprobe (bamboohr / icims / workable)
  // takes 2-3 hours sequential; with concurrency=6 it's ~25 minutes.
  const metadataBySlug = new Map<string, Record<string, string>>();
  for (const t of stale) {
    if (t.metadata && Object.keys(t.metadata).length > 0) {
      metadataBySlug.set(t.slug, t.metadata);
    }
  }
  // Concurrency: --concurrency CLI flag overrides; otherwise probeMany
  // uses its default (6) clamped by per-ATS host caps in probe.ts.
  // Operators can dial this down for shared-host ATSes that get
  // CDN-blocked under default load.
  let concurrencyOverride: number | undefined;
  if (args.concurrency !== undefined) {
    const n = Number.parseInt(args.concurrency, 10);
    if (!Number.isFinite(n) || n < 1 || n > 32) {
      console.error(`reprobe: --concurrency must be in [1, 32], got ${args.concurrency}`);
      return 2;
    }
    concurrencyOverride = n;
  }
  const probedTenants = await probeMany(
    ats,
    stale.map((t) => t.slug),
    {
      client,
      observedAt,
      metadataBySlug,
      ...(concurrencyOverride !== undefined ? { concurrency: concurrencyOverride } : {}),
      ...(args.forceRediscover ? { forceRediscover: true } : {}),
    },
  );
  const probedBySlug = new Map<string, Tenant>(probedTenants.map((p) => [p.slug, p]));
  const updated = new Map<string, Tenant>();
  for (const t of stale) {
    const result = probedBySlug.get(t.slug);
    if (!result) continue;
    const merged: Tenant = {
      ...t,
      status: result.status,
      last_probed_at: observedAt,
    };
    if (result.metadata && Object.keys(result.metadata).length > 0) {
      merged.metadata = result.metadata;
    }
    updated.set(t.slug, merged);
  }

  // Mass-failure guard — see INCIDENT_* constants above.
  const previouslyLive = stale.filter((t) => t.status === "live");
  const liveToDead = previouslyLive.filter((t) => updated.get(t.slug)?.status === "dead");
  const incidentSuspected =
    liveToDead.length >= INCIDENT_MIN_LIVE_TO_DEAD &&
    liveToDead.length >= INCIDENT_LIVE_TO_DEAD_FRACTION * previouslyLive.length;
  if (incidentSuspected) {
    for (const t of liveToDead) {
      const m = updated.get(t.slug);
      if (m) updated.set(t.slug, { ...m, status: "transient_failure" });
    }
    console.error(
      `reprobe: ${ats} → SUSPECTED INCIDENT — ${liveToDead.length}/${previouslyLive.length} live tenants flipped dead in one run; demoted to transient_failure instead of persisting as dead. Check host health before the next run.`,
    );
  }

  const next = tenants.map((t) => updated.get(t.slug) ?? t);
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tmp, path);
    /* c8 ignore next 4 — cleanup path; only reached on rare fs/rename failure mid-write. */
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }

  const liveCount = next.filter((t) => t.status === "live").length;
  console.error(
    `reprobe: ${ats} → reprobed ${stale.length} of ${tenants.length} tenants (live total: ${liveCount}; max_age_days=${maxAgeDays}, batch_size=${batchSize})`,
  );
  return 0;
}

const DEFAULT_DISCOVER_BATCH_SIZE = 200;
const DEFAULT_DISCOVER_CONCURRENCY = 6;

/**
 * Backfill `metadata.site` for workday tenants by fetching their
 * `/robots.txt` and parsing the Allow / Sitemap directives.
 *
 * The regular probe + reprobe paths can't fill this gap on their own:
 * `augmentLiveMetadata` only runs site discovery for tenants whose
 * probe URL returns 2xx, but the probe URL itself requires the site
 * (`https://{host}/{site}`). For ~99% of workday tenants the corpus
 * has `metadata.site` unset, so the probe falls back to /External which
 * 404s for tenants whose real site is named something else
 * (ATTGeneral, Comcast_Careers, GOCJobs, etc.) — the probe fails,
 * augmentLiveMetadata never runs, and the tenant stays broken forever.
 *
 * This command sidesteps the loop by going directly to robots.txt.
 * Idempotent: re-running picks up only tenants still missing a site,
 * unless --force-rediscover is set.
 */
export async function runDiscoverWorkdaySitesCommand(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }

  let userAgent: string;
  if (args.userAgent !== undefined) {
    userAgent = args.userAgent;
  } else if (args.contactUrl !== undefined) {
    userAgent = `openroles/${SCHEMA_VERSION} (+${args.contactUrl})`;
  } else {
    console.error("discover-workday-sites: --user-agent or --contact-url is required");
    return 2;
  }

  const batchSize =
    args.batchSize !== undefined
      ? Number.parseInt(args.batchSize, 10)
      : DEFAULT_DISCOVER_BATCH_SIZE;
  if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 5000) {
    console.error(
      `discover-workday-sites: --batch-size must be in [1, 5000], got ${args.batchSize}`,
    );
    return 2;
  }

  let concurrency = DEFAULT_DISCOVER_CONCURRENCY;
  if (args.concurrency !== undefined) {
    const n = Number.parseInt(args.concurrency, 10);
    if (!Number.isFinite(n) || n < 1 || n > 32) {
      console.error(
        `discover-workday-sites: --concurrency must be in [1, 32], got ${args.concurrency}`,
      );
      return 2;
    }
    concurrency = n;
  }

  const outputDir = args.outputDir ?? defaultOutputDir();
  const path = join(outputDir, "tenants", "workday.json");
  const tenants = await loadTenants(path, "workday");
  if (tenants.length === 0) {
    console.error(`discover-workday-sites: no existing tenant file at ${path}; nothing to do`);
    return 0;
  }

  // Candidates: tenants with metadata.host but no metadata.site (or all
  // tenants when --force-rediscover). Ordered by slug for deterministic
  // batching — re-runs without state will keep picking the same head.
  const candidates = tenants
    .filter((t) => {
      const host = t.metadata?.["host"];
      if (typeof host !== "string" || host.length === 0) return false;
      if (args.forceRediscover) return true;
      return t.metadata?.["site"] === undefined;
    })
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .slice(0, batchSize);
  if (candidates.length === 0) {
    console.error(
      `discover-workday-sites: all ${tenants.length} workday tenants already have metadata.site (or no host); nothing to do`,
    );
    return 0;
  }

  const robots = new RobotsTxtCache();
  const client = new HttpClient({ userAgent, robots });
  const limit = pLimit(concurrency);

  // probedSites: slug → discovered site (or null when discovery failed).
  // Distinct from "did not probe" so the summary can distinguish "robots
  // returned no Allow directive" from "we never asked".
  const probedSites = new Map<string, string | null>();
  await Promise.all(
    candidates.map((t) =>
      limit(async () => {
        const host = t.metadata?.["host"];
        if (typeof host !== "string") return;
        const site = await fetchWorkdaySite(host, client);
        probedSites.set(t.slug, site);
      }),
    ),
  );

  let discovered = 0;
  let unchanged = 0;
  const next = tenants.map((t) => {
    if (!probedSites.has(t.slug)) return t;
    const site = probedSites.get(t.slug);
    if (site === null || site === undefined) {
      unchanged += 1;
      return t;
    }
    if (t.metadata?.["site"] === site) {
      unchanged += 1;
      return t;
    }
    discovered += 1;
    const metadata: Record<string, string> = { ...(t.metadata ?? {}), site };
    return { ...t, metadata };
  });

  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tmp, path);
    /* c8 ignore next 4 — cleanup path; only reached on rare fs/rename failure mid-write. */
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }

  console.error(
    `discover-workday-sites: probed ${candidates.length} of ${tenants.length} tenants ` +
      `(discovered=${discovered}, no-allow-directive=${unchanged}, batch_size=${batchSize}, concurrency=${concurrency})`,
  );
  return 0;
}

// A discovery candidate: a brand we suspect publishes a Google-for-Jobs
// RSS feed at one of `hosts` (path is always /sitemap.xml for the
// TalentBrew/Radancy/SuccessFactors family — see specs/gjobsfeed-adapter.md).
const GjobsfeedCandidateSchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1),
});

// The signature that distinguishes a Google-for-Jobs RSS feed from a
// plain sitemaps.org <urlset> served at the same /sitemap.xml path.
const GOOGLE_JOBS_FEED_SIGNATURE = "base.google.com/ns/1.0";

// Cap the bytes inspected per probe: the namespace declaration is in
// the <rss> root element, always within the first ~200 bytes. Reading
// the whole feed (multi-MB for large brands) just to sniff the root is
// wasteful and a soft DoS vector on a hostile host.
const FEED_SNIFF_BYTES = 2048;

export async function runDiscoverGjobsfeedCommand(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }

  let userAgent: string;
  if (args.userAgent !== undefined) {
    userAgent = args.userAgent;
  } else if (args.contactUrl !== undefined) {
    userAgent = `openroles/${SCHEMA_VERSION} (+${args.contactUrl})`;
  } else {
    console.error("discover-gjobsfeed: --user-agent or --contact-url is required");
    return 2;
  }

  const batchSize =
    args.batchSize !== undefined
      ? Number.parseInt(args.batchSize, 10)
      : DEFAULT_DISCOVER_BATCH_SIZE;
  if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 5000) {
    console.error(`discover-gjobsfeed: --batch-size must be in [1, 5000], got ${args.batchSize}`);
    return 2;
  }

  let concurrency = DEFAULT_DISCOVER_CONCURRENCY;
  if (args.concurrency !== undefined) {
    const n = Number.parseInt(args.concurrency, 10);
    if (!Number.isFinite(n) || n < 1 || n > 32) {
      console.error(
        `discover-gjobsfeed: --concurrency must be in [1, 32], got ${args.concurrency}`,
      );
      return 2;
    }
    concurrency = n;
  }

  const outputDir = args.outputDir ?? defaultOutputDir();
  const candidatesPath = args.input ?? join(outputDir, "gjobsfeed-candidates.json");
  let candidates: z.infer<typeof GjobsfeedCandidateSchema>[];
  try {
    const body = await readFile(candidatesPath, "utf8");
    candidates = z.array(GjobsfeedCandidateSchema).parse(JSON.parse(body));
  } catch (err) {
    console.error(
      `discover-gjobsfeed: cannot read candidate list at ${candidatesPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 2;
  }
  if (candidates.length === 0) {
    console.error("discover-gjobsfeed: candidate list is empty; nothing to do");
    return 0;
  }

  const tenantsDir = join(outputDir, "tenants");
  const gjobsfeedPath = join(tenantsDir, "gjobsfeed.json");
  const existing = await loadTenants(gjobsfeedPath, "gjobsfeed");
  const existingSlugs = new Set(existing.map((t) => t.slug));
  // Cross-ATS dedup guard: a slug already `live` under another adapter
  // must not be re-seeded here, or the same role double-counts under
  // two ATSes with two URLs (build-db only de-dupes by exact URL).
  const liveElsewhere = await liveSlugsExcluding(tenantsDir, "gjobsfeed");

  const robots = new RobotsTxtCache();
  const client = new HttpClient({ userAgent, robots });
  const limit = pLimit(concurrency);

  const notYetSeeded = candidates.filter((c) => !existingSlugs.has(c.slug));
  const alreadySeeded = candidates.length - notYetSeeded.length;
  const queue = notYetSeeded.sort((a, b) => a.slug.localeCompare(b.slug)).slice(0, batchSize);

  let discovered = 0;
  let skippedDup = 0;
  let noFeed = 0;
  const found = new Map<string, { display_name: string; feed_url: string }>();
  await Promise.all(
    queue.map((c) =>
      limit(async () => {
        if (liveElsewhere.has(c.slug)) {
          skippedDup += 1;
          console.error(
            `discover-gjobsfeed: skip ${c.slug} — already live under another ATS (dedup guard)`,
          );
          return;
        }
        for (const host of c.hosts) {
          const feedUrl = `https://${host}/sitemap.xml`;
          let parsed: URL;
          try {
            parsed = new URL(feedUrl);
          } catch {
            continue;
          }
          if (!isSafeFetchHost(parsed)) continue;
          try {
            const res = await client.request(feedUrl);
            const body = await res.text();
            if (body.slice(0, FEED_SNIFF_BYTES).includes(GOOGLE_JOBS_FEED_SIGNATURE)) {
              found.set(c.slug, { display_name: c.display_name, feed_url: feedUrl });
              discovered += 1;
              return;
            }
          } catch {
            // host unreachable / robots-blocked / non-2xx — try next host
          }
        }
        noFeed += 1;
      }),
    ),
  );

  if (found.size > 0) {
    const now = new Date().toISOString();
    const additions: Tenant[] = [...found.entries()].map(([slug, v]) => ({
      ats: "gjobsfeed",
      slug,
      display_name: v.display_name,
      status: "transient_failure",
      last_probed_at: now,
      first_seen_at: now,
      metadata: { feed_url: v.feed_url },
    }));
    const next = [...existing, ...additions].sort((a, b) => a.slug.localeCompare(b.slug));
    const tmp = `${gjobsfeedPath}.tmp`;
    try {
      await mkdir(tenantsDir, { recursive: true });
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
      await rename(tmp, gjobsfeedPath);
      /* c8 ignore next 4 — cleanup path; only reached on rare fs/rename failure mid-write. */
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  console.error(
    `discover-gjobsfeed: probed ${queue.length} of ${candidates.length} candidates ` +
      `(discovered=${discovered}, skipped-dup=${skippedDup}, no-feed=${noFeed}, ` +
      `already-seeded=${alreadySeeded}, batch_size=${batchSize}, concurrency=${concurrency})`,
  );
  return 0;
}

// Platform-sitemap tenant-discovery. Reads a platform's public sitemap
// index (a second discovery source alongside CDX) and merges the tenants
// it enumerates into data/tenants/{ats}.json — new slugs seeded as
// transient_failure (the reprobe pass validates them), and, for
// liveness-truth sources (jazzhr), stale dead/transient slugs the sitemap
// re-asserts as live are reset for immediate re-probe. See
// specs/sitemap-discovery.md.
export async function runDiscoverSitemapCommand(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (args.ats === undefined) {
    console.error("discover-sitemap: --ats <id> is required");
    return 2;
  }
  const atsParse = ATSIdSchema.safeParse(args.ats);
  if (!atsParse.success) {
    console.error(`discover-sitemap: --ats must be one of ${ATS_IDS.join("|")}, got ${args.ats}`);
    return 2;
  }
  const ats: ATSId = atsParse.data;
  const source = sitemapSourceFor(ats);
  if (source === undefined) {
    console.error(
      `discover-sitemap: no sitemap source configured for '${ats}'. ` +
        "Supported: isolvedhire, jazzhr, hiringthing. See specs/sitemap-discovery.md.",
    );
    return 2;
  }

  let maxChildren = source.maxChildren;
  if (args.max !== undefined) {
    const n = Number.parseInt(args.max, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100_000) {
      console.error(`discover-sitemap: --max must be in [1, 100000], got ${args.max}`);
      return 2;
    }
    // --max only bounds child-sitemap descent. A non-descending source
    // (isolvedhire/jazzhr) fetches its index in one shot, so the flag has
    // no effect — say so rather than silently ignore it.
    if (!source.descend) {
      console.error(
        `discover-sitemap: --max is ignored for '${ats}' (it does not descend into ` +
          "child sitemaps; the index is fetched in one request)",
      );
    }
    maxChildren = n;
  }

  const outputDir = args.outputDir ?? defaultOutputDir();
  const tenantsDir = join(outputDir, "tenants");
  const path = args.tenantsFile ?? join(tenantsDir, `${ats}.json`);

  const fetched = await fetchSitemapSlugs({ ats, maxChildren });
  if (fetched.slugs.length === 0) {
    console.error(
      `discover-sitemap: ${ats} sitemap yielded no slugs ` +
        `(children_attempted=${fetched.childrenAttempted}, ` +
        `children_failed=${fetched.childrenFailed}); nothing to do`,
    );
    return 0;
  }

  const existing = await loadTenants(path, ats);
  // Cross-ATS dedup guard: a slug already live under another adapter must
  // not be re-seeded here (build-db de-dupes only by exact URL).
  const liveElsewhere = await liveSlugsExcluding(tenantsDir, ats);

  const merged = mergeSitemapSlugs({
    ats,
    existing,
    sitemapSlugs: fetched.slugs,
    liveElsewhere,
    livenessTruth: source.livenessTruth,
    now: new Date().toISOString(),
  });

  if (args.dryRun) {
    console.error(
      `discover-sitemap: DRY RUN ${ats} — fetched=${fetched.slugs.length} ` +
        `new=${merged.added} resurrected=${merged.resurrected} skipped=${merged.skipped} ` +
        `(children_attempted=${fetched.childrenAttempted}, ` +
        `children_failed=${fetched.childrenFailed}, truncated=${fetched.truncated}); ` +
        "no file written",
    );
    return 0;
  }

  if (merged.added > 0 || merged.resurrected > 0) {
    await mkdir(tenantsDir, { recursive: true });
    const tmp = `${path}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(merged.tenants, null, 2)}\n`);
      await rename(tmp, path);
      /* c8 ignore next 4 — cleanup path; only reached on rare fs/rename failure mid-write. */
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  console.error(
    `discover-sitemap: ${ats} — fetched=${fetched.slugs.length} ` +
      `new=${merged.added} resurrected=${merged.resurrected} skipped=${merged.skipped} ` +
      `(children_attempted=${fetched.childrenAttempted}, ` +
      `children_failed=${fetched.childrenFailed}, truncated=${fetched.truncated})`,
  );
  return 0;
}

// Operator-run Common Crawl columnar-index enumeration. Heavyweight
// (a few hundred GB Parquet scan, ~$1-3 via Athena / a large httpfs
// stream via the duckdb CLI) and deliberately NOT part of CI — see
// specs/gjobsfeed-cc-enumeration.md. Refuses to run without an
// explicit --crawl and the duckdb binary, so nothing can trigger the
// scan silently.
export async function runEnumerateGjobsfeedHostsCommand(
  argv: ReadonlyArray<string>,
): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }

  const crawl = args.snapshots;
  if (crawl === undefined || !/^CC-MAIN-\d{4}-\d{2}$/.test(crawl)) {
    console.error(
      "enumerate-gjobsfeed-hosts: --snapshots <CC-MAIN-YYYY-NN> is required " +
        "(the crawl to enumerate; this is a paid, operator-run scan)",
    );
    return 2;
  }

  const duckdbPath = Bun.which("duckdb");
  if (duckdbPath === null) {
    console.error(
      "enumerate-gjobsfeed-hosts: `duckdb` not found on PATH. This command " +
        "runs a Common Crawl columnar-index scan via the DuckDB CLI; install " +
        "duckdb and re-run. (Not a CI step — see specs/gjobsfeed-cc-enumeration.md.)",
    );
    return 2;
  }

  const outputDir = args.outputDir ?? defaultOutputDir();
  const candidatesPath = args.input ?? join(outputDir, "gjobsfeed-candidates.json");
  let existing: GjobsfeedCandidate[] = [];
  try {
    const body = await readFile(candidatesPath, "utf8");
    existing = z
      .array(
        z.object({
          slug: z.string().min(1),
          display_name: z.string().min(1),
          hosts: z.array(z.string().min(1)).min(1),
        }),
      )
      .parse(JSON.parse(body));
    /* c8 ignore next 3 — first-run convenience: a missing/empty list is fine, we create it. */
  } catch {
    existing = [];
  }

  const sql = buildEnumerationSql(crawl);
  const proc = Bun.spawn([duckdbPath, "-csv", "-c", sql], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    console.error(
      `enumerate-gjobsfeed-hosts: duckdb exited ${exitCode}: ${stderr.trim().slice(0, 500)}`,
    );
    return 1;
  }

  const hosts = parseDuckdbHostRows(stdout);
  const { candidates, added, hostsAddedToExisting, skipped } = mergeCandidates(existing, hosts);

  if (added > 0 || hostsAddedToExisting > 0) {
    const tmp = `${candidatesPath}.tmp`;
    try {
      await mkdir(dirname(candidatesPath), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(candidates, null, 2)}\n`);
      await rename(tmp, candidatesPath);
      /* c8 ignore next 4 — cleanup path; only reached on rare fs/rename failure mid-write. */
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  console.error(
    `enumerate-gjobsfeed-hosts: ${crawl} → ${hosts.length} career-prefixed sitemap hosts ` +
      `(added=${added}, hosts-merged-into-existing=${hostsAddedToExisting}, ` +
      `unparseable-skipped=${skipped}, candidates-total=${candidates.length}). ` +
      "Run `discover-gjobsfeed` next to probe + seed.",
  );
  return 0;
}

type FailSeverity = "info" | "warn" | "error";

const SEVERITY_ORDER: Record<FailSeverity, number> = { info: 0, warn: 1, error: 2 };

function parseFailOn(raw: string | undefined): FailSeverity {
  if (raw === "info" || raw === "warn" || raw === "error") return raw;
  return "error";
}

export async function runReportCommand(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  const inputDir = args.input ?? defaultOutputDir();
  const manifestPath = join(inputDir, "manifest.json");
  const manifest: Manifest = ManifestSchema.parse(await readJsonOrThrow(manifestPath, "report"));

  const outputs: ScrapeOutput[] = [];
  const entries = (await readdir(inputDir)).sort();
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name === "manifest.json") continue;
    if (name.startsWith("tenants")) continue;
    const path = join(inputDir, name);
    const parsed = ScrapeOutputSchema.safeParse(await readJsonOrThrow(path, "report"));
    if (parsed.success) outputs.push(parsed.data);
  }

  let previous: Manifest | null = null;
  if (args.previousManifest !== undefined) {
    previous = ManifestSchema.parse(await readJsonOrThrow(args.previousManifest, "report"));
  }
  const drift = detectDrift(previous, manifest);

  let deadTenants: ReturnType<typeof detectDeadTenants> = [];
  if (args.tenantsHistory !== undefined) {
    const history = z
      .array(
        z.object({
          observed_at: z.string(),
          tenants: z.array(TenantSchema),
        }),
      )
      .parse(
        await readJsonOrThrow(args.tenantsHistory, "report"),
      ) satisfies ReadonlyArray<TenantSnapshot>;
    const consecutive = Math.max(1, Number.parseInt(args.consecutiveDead ?? "3", 10) || 3);
    deadTenants = detectDeadTenants(history, consecutive);
  }

  const md = renderRunReport({ manifest, outputs, drift, deadTenants });
  if (args.output !== undefined) {
    await writeFile(args.output, md);
  } else {
    process.stdout.write(md);
  }

  const failOn = parseFailOn(args.failOn);
  if (drift.length > 0) {
    const observed = maxSeverity(drift);
    if (SEVERITY_ORDER[observed] >= SEVERITY_ORDER[failOn]) {
      console.error(`report: drift severity ${observed} reached --fail-on=${failOn}`);
      return 1;
    }
  }
  return 0;
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [, , command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    return command ? 0 : 1;
  }
  if (command === "scrape") return await runScrapeCommand(rest);
  if (command === "build-db") return await runBuildDbCommand(rest);
  if (command === "harvest") return await runHarvestCommand(rest);
  if (command === "reprobe") return await runReprobeCommand(rest);
  if (command === "discover-workday-sites") {
    return await runDiscoverWorkdaySitesCommand(rest);
  }
  if (command === "discover-gjobsfeed") {
    return await runDiscoverGjobsfeedCommand(rest);
  }
  if (command === "discover-sitemap") {
    return await runDiscoverSitemapCommand(rest);
  }
  if (command === "enumerate-gjobsfeed-hosts") {
    return await runEnumerateGjobsfeedHostsCommand(rest);
  }
  if (command === "report") return await runReportCommand(rest);
  console.error(`Command '${command}' is not implemented yet.`);
  return 2;
}
