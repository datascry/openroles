#!/usr/bin/env bun
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ATSId,
  ATSIdSchema,
  SCHEMA_VERSION,
  type ScrapeOutput,
  ScrapeOutputSchema,
  type Tenant,
  TenantSchema,
} from "@openroles/shared";
import { z } from "zod";
import { buildDb } from "./db/build-db.ts";
import { SNAPSHOT_ID_RE } from "./harvest/cdx.ts";
import { runHarvest } from "./harvest/runner.ts";
import { resolveLatestSnapshots } from "./harvest/snapshots.ts";
import { HttpClient } from "./http.ts";
import { RobotsTxtCache } from "./robots.ts";
import { runScrape } from "./scrape.ts";

function usage(): void {
  console.error(`
openroles-scrape — schema ${SCHEMA_VERSION}

Usage:
  openroles-scrape <command> [options]

Commands:
  scrape       Run the ATS scrapers against a tenant list
  harvest      Refresh tenant lists from Common Crawl (Phase 5)
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

harvest:
  --ats <id>              ATS to harvest (greenhouse | lever | ashby | bamboohr | workday | icims)
  --snapshots <list>      Comma-separated CC-MAIN snapshot ids (YYYY-NN). Default: latest 4 from collinfo.json
  --output-dir <dir>      Where to write tenants/{ats}.json (default: ./data)
  --skip-probe            Emit slugs without liveness probing
  --user-agent <ua>       Override the full User-Agent string
  --contact-url <url>     Contact URL interpolated into the default User-Agent (required if --user-agent is omitted)
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
  readonly skipProbe: boolean;
  readonly userAgent: string | undefined;
  readonly contactUrl: string | undefined;
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
  let skipProbe = false;
  let userAgent: string | undefined;
  let contactUrl: string | undefined;
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
    if (a === "--input") input = argv[++i];
    else if (a === "--output") output = argv[++i];
    else if (a === "--output-dir") outputDir = argv[++i];
    else if (a === "--tenants") tenants = argv[++i];
    else if (a === "--short-sha") shortSha = argv[++i];
    else if (a === "--notes") notes = argv[++i];
    else if (a === "--ats") ats = argv[++i];
    else if (a === "--snapshots") snapshots = argv[++i];
    else if (a === "--user-agent") userAgent = argv[++i];
    else if (a === "--contact-url") contactUrl = argv[++i];
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
    skipProbe,
    userAgent,
    contactUrl,
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

async function readJsonOrThrow(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`build-db: failed to parse ${path}: ${msg}`);
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

  const entries = (await readdir(args.input)).sort();
  const outputs: ScrapeOutput[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(args.input, name);
    outputs.push(ScrapeOutputSchema.parse(await readJsonOrThrow(path)));
  }

  let tenants: Tenant[] = [];
  if (args.tenants !== undefined) {
    tenants = z.array(TenantSchema).parse(await readJsonOrThrow(args.tenants));
  }

  const builtAt = new Date().toISOString();
  const dbPath = join(outputDir, `jobs.${shortSha}.sqlite`);
  const dbTmp = `${dbPath}.tmp`;
  const manifestPath = join(outputDir, "manifest.json");
  const manifestTmp = `${manifestPath}.tmp`;
  await rm(dbTmp, { force: true });
  let manifest: ReturnType<typeof buildDb>["manifest"];
  try {
    const { db, manifest: m } = buildDb(
      {
        outputs,
        tenants,
        buildShortSha: shortSha,
        builtAt,
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
      },
      dbTmp,
    );
    db.close();
    manifest = m;
    await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(dbTmp, dbPath);
    await rename(manifestTmp, manifestPath);
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
    console.error(
      `harvest: --ats must be one of greenhouse|lever|ashby|bamboohr|workday|icims, got ${args.ats}`,
    );
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
  } else {
    snapshots = await resolveLatestSnapshots(client, 4);
    if (snapshots.length === 0) {
      console.error("harvest: failed to resolve latest CC-MAIN snapshots; pass --snapshots");
      return 2;
    }
  }
  const result = await runHarvest({
    ats,
    snapshots,
    client,
    observedAt: new Date().toISOString(),
    ...(args.skipProbe ? { skipProbe: true } : {}),
  });
  const outputDir = args.outputDir ?? "./data";
  const tenantsDir = join(outputDir, "tenants");
  await mkdir(tenantsDir, { recursive: true });
  const path = join(tenantsDir, `${ats}.json`);
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(result.tenants, null, 2)}\n`);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  console.error(
    `harvest: ${ats} → ${result.unique_slugs} unique slugs from ${result.cdx_records} CDX records (${result.tenants.filter((t) => t.status === "live").length} live)`,
  );
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
  console.error(`Command '${command}' is not implemented yet (Phase 6+).`);
  return 2;
}
