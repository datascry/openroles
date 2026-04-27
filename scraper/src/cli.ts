#!/usr/bin/env bun
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  type ScrapeOutput,
  ScrapeOutputSchema,
  type Tenant,
  TenantSchema,
} from "@openroles/shared";
import { z } from "zod";
import { buildDb } from "./db/build-db.ts";
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
`);
}

interface ParsedArgs {
  readonly input: string | undefined;
  readonly output: string | undefined;
  readonly outputDir: string | undefined;
  readonly tenants: string | undefined;
  readonly shortSha: string | undefined;
  readonly notes: string | undefined;
  readonly help: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let input: string | undefined;
  let output: string | undefined;
  let outputDir: string | undefined;
  let tenants: string | undefined;
  let shortSha: string | undefined;
  let notes: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--input") input = argv[++i];
    else if (a === "--output") output = argv[++i];
    else if (a === "--output-dir") outputDir = argv[++i];
    else if (a === "--tenants") tenants = argv[++i];
    else if (a === "--short-sha") shortSha = argv[++i];
    else if (a === "--notes") notes = argv[++i];
  }
  return { input, output, outputDir, tenants, shortSha, notes, help };
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
  const explicitSha = args.shortSha ?? process.env["BUILD_SHORT_SHA"];
  const shortSha = explicitSha ?? "dev0001";
  if (!SHORT_SHA_RE.test(shortSha)) {
    console.error(`build-db: --short-sha must match ${SHORT_SHA_RE.source}, got ${shortSha}`);
    return 2;
  }
  if (explicitSha === undefined) {
    console.error(
      "build-db: no --short-sha or BUILD_SHORT_SHA env set; using placeholder 'dev0001'",
    );
  }
  const outputDir = args.outputDir ?? "./data";
  await mkdir(outputDir, { recursive: true });

  const entries = (await readdir(args.input)).slice().sort();
  const outputs: ScrapeOutput[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const raw = JSON.parse(await readFile(join(args.input, name), "utf8"));
    outputs.push(ScrapeOutputSchema.parse(raw));
  }

  let tenants: Tenant[] = [];
  if (args.tenants !== undefined) {
    const raw = JSON.parse(await readFile(args.tenants, "utf8"));
    tenants = z.array(TenantSchema).parse(raw);
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

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [, , command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    return command ? 0 : 1;
  }
  if (command === "scrape") return await runScrapeCommand(rest);
  if (command === "build-db") return await runBuildDbCommand(rest);
  console.error(`Command '${command}' is not implemented yet (Phase 5+).`);
  return 2;
}
