#!/usr/bin/env bun
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import { z } from "zod";
import { buildDb } from "./db/build-db.ts";
import { SNAPSHOT_ID_RE } from "./harvest/cdx.ts";
import { probeOne } from "./harvest/probe.ts";
import { runHarvest } from "./harvest/runner.ts";
import { resolveAllSnapshots, resolveLatestSnapshots } from "./harvest/snapshots.ts";
import { HttpClient } from "./http.ts";
import { detectDeadTenants, type TenantSnapshot } from "./observability/dead-tenants.ts";
import { detectDrift, maxSeverity } from "./observability/drift.ts";
import { renderRunReport } from "./observability/run-report.ts";
import { RobotsTxtCache } from "./robots.ts";
import { runScrape } from "./scrape.ts";

function usage(): void {
  console.error(`
openroles-scrape — schema ${SCHEMA_VERSION}

Usage:
  openroles-scrape <command> [options]

Commands:
  scrape       Run the ATS scrapers against a tenant list
  harvest      Discover tenant slugs from Common Crawl (incremental-aware)
  reprobe      Re-probe stale tenants for liveness updates
  build-db     Build data/jobs.{sha}.sqlite from one or more scrape outputs
  report       Print run report from data/run-report.json (Phase 7)

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

reprobe:
  --ats <id>              ATS whose tenants to reprobe
  --max-age-days <n>      Reprobe tenants whose last_probed_at is older than this many days (default: 7)
  --batch-size <n>        Cap per-run reprobe count (default: 5000, max: 100000)
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
  readonly skipProbe: boolean;
  readonly userAgent: string | undefined;
  readonly contactUrl: string | undefined;
  readonly previousManifest: string | undefined;
  readonly previousDb: string | undefined;
  readonly staleTtlDays: string | undefined;
  readonly tenantsHistory: string | undefined;
  readonly consecutiveDead: string | undefined;
  readonly failOn: string | undefined;
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
  let skipProbe = false;
  let userAgent: string | undefined;
  let contactUrl: string | undefined;
  let previousManifest: string | undefined;
  let previousDb: string | undefined;
  let staleTtlDays: string | undefined;
  let tenantsHistory: string | undefined;
  let consecutiveDead: string | undefined;
  let failOn: string | undefined;
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
    if (a === "--incremental") {
      incremental = true;
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
    else if (a === "--user-agent") userAgent = argv[++i];
    else if (a === "--contact-url") contactUrl = argv[++i];
    else if (a === "--previous-manifest") previousManifest = argv[++i];
    else if (a === "--previous-db") previousDb = argv[++i];
    else if (a === "--stale-ttl-days") staleTtlDays = argv[++i];
    else if (a === "--tenants-history") tenantsHistory = argv[++i];
    else if (a === "--consecutive-dead") consecutiveDead = argv[++i];
    else if (a === "--fail-on") failOn = argv[++i];
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
    skipProbe,
    userAgent,
    contactUrl,
    previousManifest,
    previousDb,
    staleTtlDays,
    tenantsHistory,
    consecutiveDead,
    failOn,
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
  const outputDir = args.outputDir ?? "./data";
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
    db.close();
    manifest = m;
    await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(dbTmp, dbPath);
    await rename(manifestTmp, manifestPath);
    /* c8 ignore next 5 — cleanup path; only reached on rare fs/rename failure mid-write. */
  } catch (err) {
    await rm(dbTmp, { force: true });
    await rm(manifestTmp, { force: true });
    throw err;
  }
  console.error(
    `build-db: ${manifest.total_rows} jobs → ${dbPath} (sha=${shortSha}, tenants=${manifest.tenants_total})`,
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
  const outputDir = args.outputDir ?? "./data";
  const stateFilePath = args.stateFile ?? join(outputDir, "harvest-state", `${ats}.json`);
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
    const all = await resolveAllSnapshots(client);
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
    snapshots = await resolveAllSnapshots(client, yr);
    /* c8 ignore next 4 — defensive: only fires if collinfo.json has nothing for the requested year (extreme edge). */
    if (snapshots.length === 0) {
      console.error(`harvest: collinfo.json yielded no snapshots since ${yr}`);
      return 2;
    }
  } else {
    snapshots = await resolveLatestSnapshots(client, 40);
    if (snapshots.length === 0) {
      console.error("harvest: failed to resolve latest CC-MAIN snapshots; pass --snapshots");
      return 2;
    }
  }

  const tenantsDir = join(outputDir, "tenants");
  await mkdir(tenantsDir, { recursive: true });
  const path = join(tenantsDir, `${ats}.json`);
  const existingTenants = await loadTenants(path, ats);

  const result = await runHarvest({
    ats,
    snapshots,
    client,
    observedAt,
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

  const outputDir = args.outputDir ?? "./data";
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
  const updated = new Map<string, Tenant>();
  // Sequential probing keeps the rate gentle for the host shared across
  // all of a tenant's probes; concurrency added later if a per-host
  // budget makes sense (different ATSes already run in different matrix
  // legs, so overall parallelism is provided at the workflow layer).
  for (const t of stale) {
    const result = await probeOne(ats, t.slug, client, observedAt, t.metadata);
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
  const inputDir = args.input ?? "./data";
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
  if (command === "report") return await runReportCommand(rest);
  console.error(`Command '${command}' is not implemented yet.`);
  return 2;
}
