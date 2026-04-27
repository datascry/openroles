#!/usr/bin/env bun
// Scraper CLI entrypoint.
// Subcommands: scrape | harvest | build-db | report
// Implementations land in Phase 2 onwards.

import { SCHEMA_VERSION } from "@openroles/shared";

function usage(): void {
  console.error(`
openroles-scrape — schema ${SCHEMA_VERSION}

Usage:
  openroles-scrape <command> [options]

Commands:
  scrape       Run the ATS scrapers against the active tenant lists
  harvest      Refresh tenant lists from Common Crawl
  build-db     Emit data/jobs.{sha}.sqlite from the latest scrape output
  report       Print run report from data/run-report.json

Run 'openroles-scrape <command> --help' for command-specific options.
`);
}

const [, , command] = process.argv;

if (!command || command === "--help" || command === "-h") {
  usage();
  process.exit(command ? 0 : 1);
}

console.error(`Command '${command}' is not implemented yet (Phase 2+).`);
process.exit(2);
