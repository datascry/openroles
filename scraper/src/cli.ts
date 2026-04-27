#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { SCHEMA_VERSION } from "@openroles/shared";
import { runScrape } from "./scrape.ts";

function usage(): void {
  console.error(`
openroles-scrape — schema ${SCHEMA_VERSION}

Usage:
  openroles-scrape <command> [options]

Commands:
  scrape       Run the ATS scrapers against a tenant list
  harvest      Refresh tenant lists from Common Crawl (Phase 5)
  build-db     Emit data/jobs.{sha}.sqlite from the latest scrape output (Phase 3)
  report       Print run report from data/run-report.json (Phase 7)

scrape:
  --input <path>     Path to a JSON file with a ScrapeInput body
  --output <path>    Path to write the ScrapeOutput JSON (default: stdout)
`);
}

interface ParsedArgs {
  readonly input: string | undefined;
  readonly output: string | undefined;
  readonly help: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let input: string | undefined;
  let output: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--input") {
      input = argv[++i];
      continue;
    }
    if (a === "--output") {
      output = argv[++i];
    }
  }
  return { input, output, help };
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

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [, , command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    return command ? 0 : 1;
  }
  if (command === "scrape") return await runScrapeCommand(rest);
  console.error(`Command '${command}' is not implemented yet (Phase 3+).`);
  return 2;
}
