import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  runBuildDbCommand,
  runDiscoverGjobsfeedCommand,
  runDiscoverSitemapCommand,
  runDiscoverWorkdaySitesCommand,
  runEnumerateGjobsfeedHostsCommand,
  runHarvestCommand,
  runReportCommand,
  runReprobeCommand,
  runScrapeCommand,
} from "./cli.ts";
import { urlHostIs, urlHostMatches } from "./harvest/test-helpers.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "openroles-cli-"));
}

describe("main", () => {
  it("prints usage and exits 0 on --help", async () => {
    const code = await main(["bun", "cli.ts", "--help"]);
    expect(code).toBe(0);
  });

  it("prints usage and exits 1 when no command", async () => {
    const code = await main(["bun", "cli.ts"]);
    expect(code).toBe(1);
  });

  it("returns 2 for unknown commands", async () => {
    const code = await main(["bun", "cli.ts", "wat"]);
    expect(code).toBe(2);
  });
});

const SAMPLE_MANIFEST = {
  schema_version: "1.0.0",
  built_at: "2026-04-26T00:00:00Z",
  short_sha: "abc1234",
  db_filename: "jobs.abc1234.sqlite",
  total_rows: 12,
  ats_counts: {
    greenhouse: 5,
    lever: 3,
    ashby: 1,
    bamboohr: 1,
    workday: 1,
    icims: 1,
  },
  tenants_total: 5,
  tenants_live: 4,
};

function setupReportDir(): string {
  const dir = tmpDir();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(SAMPLE_MANIFEST));
  writeFileSync(
    join(dir, "greenhouse.json"),
    JSON.stringify({
      ats: "greenhouse",
      jobs: [],
      tenant_results: [],
      metrics: {
        started_at: "2026-04-26T00:00:00Z",
        finished_at: "2026-04-26T00:00:00Z",
        duration_ms: 1500,
        requests_made: 10,
        requests_failed: 1,
        requests_retried: 1,
        bytes_received: 4096,
      },
    }),
  );
  return dir;
}

describe("runReportCommand", () => {
  it("returns 0 on --help", async () => {
    expect(await runReportCommand(["--help"])).toBe(0);
  });

  it("renders a report and writes to --output", async () => {
    const dir = setupReportDir();
    const out = join(dir, "report.md");
    const code = await runReportCommand(["--input", dir, "--output", out]);
    expect(code).toBe(0);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("openroles run report — abc1234");
    expect(md).toContain("Jobs: **12**");
  });

  it("writes the report to stdout when --output is omitted", async () => {
    const dir = setupReportDir();
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runReportCommand(["--input", dir]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(captured).toContain("openroles run report");
  });

  it("compares against a previous manifest and includes drift findings", async () => {
    const dir = setupReportDir();
    const prevManifest = {
      ...SAMPLE_MANIFEST,
      total_rows: 100,
      short_sha: "0000000",
      // The cross-field check (audit M1) requires db_filename to embed the
      // declared short_sha; the prev manifest has a different sha than the
      // current SAMPLE_MANIFEST, so override db_filename to match.
      db_filename: "jobs.0000000.sqlite",
      ats_counts: {
        greenhouse: 50,
        lever: 25,
        ashby: 10,
        bamboohr: 10,
        workday: 3,
        icims: 2,
      },
    };
    const prevPath = join(dir, "previous-manifest.json");
    writeFileSync(prevPath, JSON.stringify(prevManifest));
    const out = join(dir, "report.md");
    const code = await runReportCommand([
      "--input",
      dir,
      "--previous-manifest",
      prevPath,
      "--output",
      out,
      "--fail-on",
      "warn",
    ]);
    // total_rows dropped 100 → 12 = 88% drop = error
    expect(code).toBe(1);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("total-rows-drop");
  });

  it("returns 0 when drift severity is below --fail-on", async () => {
    const dir = setupReportDir();
    const out = join(dir, "report.md");
    const code = await runReportCommand(["--input", dir, "--output", out, "--fail-on", "error"]);
    expect(code).toBe(0);
  });

  it("returns 0 with --fail-on=info on a stable build (no drift)", async () => {
    const dir = setupReportDir();
    const prevPath = join(dir, "previous-manifest.json");
    writeFileSync(prevPath, JSON.stringify(SAMPLE_MANIFEST));
    const out = join(dir, "report.md");
    const code = await runReportCommand([
      "--input",
      dir,
      "--previous-manifest",
      prevPath,
      "--output",
      out,
      "--fail-on",
      "info",
    ]);
    expect(code).toBe(0);
  });

  it("returns 1 with --fail-on=info when only info findings are present (first build)", async () => {
    const dir = setupReportDir();
    const out = join(dir, "report.md");
    // No --previous-manifest → drift returns one "first-build" info finding.
    const code = await runReportCommand(["--input", dir, "--output", out, "--fail-on", "info"]);
    expect(code).toBe(1);
  });

  it("includes dead-tenant alerts from --tenants-history", async () => {
    const dir = setupReportDir();
    const historyPath = join(dir, "history.json");
    writeFileSync(
      historyPath,
      JSON.stringify([
        {
          observed_at: "2026-03-01T00:00:00Z",
          tenants: [
            {
              ats: "greenhouse",
              slug: "alpha",
              status: "dead",
              last_probed_at: "2026-03-01T00:00:00Z",
            },
          ],
        },
        {
          observed_at: "2026-04-01T00:00:00Z",
          tenants: [
            {
              ats: "greenhouse",
              slug: "alpha",
              status: "dead",
              last_probed_at: "2026-04-01T00:00:00Z",
            },
          ],
        },
      ]),
    );
    const out = join(dir, "report.md");
    const code = await runReportCommand([
      "--input",
      dir,
      "--tenants-history",
      historyPath,
      "--consecutive-dead",
      "2",
      "--output",
      out,
    ]);
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("| greenhouse | alpha |");
  });

  it("dispatches report via main() too", async () => {
    const dir = setupReportDir();
    const code = await main([
      "bun",
      "cli.ts",
      "report",
      "--input",
      dir,
      "--output",
      join(dir, "r.md"),
    ]);
    expect(code).toBe(0);
  });
});

describe("runScrapeCommand", () => {
  it("returns 0 when called with --help", async () => {
    const code = await runScrapeCommand(["--help"]);
    expect(code).toBe(0);
  });

  it("returns 2 when --input is missing", async () => {
    const code = await runScrapeCommand([]);
    expect(code).toBe(2);
  });

  it("writes output JSON when --output is given", async () => {
    const dir = tmpDir();
    const inputPath = join(dir, "input.json");
    const outputPath = join(dir, "output.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        ats: "greenhouse",
        tenants: [],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      }),
    );
    const code = await runScrapeCommand(["--input", inputPath, "--output", outputPath]);
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(out.ats).toBe("greenhouse");
    expect(out.jobs).toEqual([]);
  });

  it("writes output to stdout when --output is omitted", async () => {
    const dir = tmpDir();
    const inputPath = join(dir, "input.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        ats: "greenhouse",
        tenants: [],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      }),
    );
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runScrapeCommand(["--input", inputPath]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const out = JSON.parse(captured);
    expect(out.ats).toBe("greenhouse");
  });

  it("dispatches scrape via main() too", async () => {
    const dir = tmpDir();
    const inputPath = join(dir, "input.json");
    const outputPath = join(dir, "output.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        ats: "greenhouse",
        tenants: [],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      }),
    );
    const code = await main([
      "bun",
      "cli.ts",
      "scrape",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ]);
    expect(code).toBe(0);
  });
});

function emptyOutput(): unknown {
  return {
    ats: "greenhouse",
    jobs: [],
    tenant_results: [],
    metrics: {
      started_at: "2026-04-26T00:00:00Z",
      finished_at: "2026-04-26T00:00:00Z",
      duration_ms: 0,
      requests_made: 0,
      requests_failed: 0,
      requests_retried: 0,
      bytes_received: 0,
    },
  };
}

describe("runBuildDbCommand", () => {
  it("returns 0 when called with --help", async () => {
    const code = await runBuildDbCommand(["--help"]);
    expect(code).toBe(0);
  });

  it("returns 2 when --input is missing", async () => {
    const code = await runBuildDbCommand([]);
    expect(code).toBe(2);
  });

  it("uses dev0001 placeholder when no --short-sha or env is set", async () => {
    const original = process.env["BUILD_SHORT_SHA"];
    delete process.env["BUILD_SHORT_SHA"];
    try {
      const dir = tmpDir();
      const inputDir = join(dir, "in");
      const outputDir = join(dir, "out");
      mkdirSync(inputDir);
      writeFileSync(join(inputDir, "out.json"), JSON.stringify(emptyOutput()));
      const code = await runBuildDbCommand(["--input", inputDir, "--output-dir", outputDir]);
      expect(code).toBe(0);
      expect(existsSync(join(outputDir, "jobs.0000000.sqlite"))).toBe(true);
    } finally {
      if (original !== undefined) process.env["BUILD_SHORT_SHA"] = original;
    }
  });

  it("rejects malformed --short-sha", async () => {
    const dir = tmpDir();
    const code = await runBuildDbCommand([
      "--input",
      dir,
      "--output-dir",
      dir,
      "--short-sha",
      "NOT-HEX",
    ]);
    expect(code).toBe(2);
  });

  it("emits jobs.{sha}.sqlite and manifest.json from a scrape-output dir", async () => {
    const dir = tmpDir();
    const inputDir = join(dir, "in");
    const outputDir = join(dir, "out");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "greenhouse.json"), JSON.stringify(emptyOutput()));
    const code = await runBuildDbCommand([
      "--input",
      inputDir,
      "--output-dir",
      outputDir,
      "--short-sha",
      "abc1234",
      "--notes",
      "smoke",
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(outputDir, "jobs.abc1234.sqlite"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
    expect(manifest.short_sha).toBe("abc1234");
    expect(manifest.total_rows).toBe(0);
  });

  it("loads --tenants and reflects them in the manifest", async () => {
    const dir = tmpDir();
    const inputDir = join(dir, "in");
    const outputDir = join(dir, "out");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "out.json"), JSON.stringify(emptyOutput()));
    const tenantsPath = join(dir, "tenants.json");
    writeFileSync(
      tenantsPath,
      JSON.stringify([
        {
          ats: "greenhouse",
          slug: "alpha",
          status: "live",
          last_probed_at: "2026-04-26T00:00:00Z",
        },
        { ats: "lever", slug: "beta", status: "dead", last_probed_at: "2026-04-26T00:00:00Z" },
      ]),
    );
    const code = await runBuildDbCommand([
      "--input",
      inputDir,
      "--output-dir",
      outputDir,
      "--short-sha",
      "abc1234",
      "--tenants",
      tenantsPath,
    ]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
    expect(manifest.tenants_total).toBe(2);
    expect(manifest.tenants_live).toBe(1);
  });

  it("wraps malformed scrape JSON with the file path in the error", async () => {
    const dir = tmpDir();
    const inputDir = join(dir, "in");
    const outputDir = join(dir, "out");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "broken.json"), "{not json");
    await expect(
      runBuildDbCommand(["--input", inputDir, "--output-dir", outputDir, "--short-sha", "abc1234"]),
    ).rejects.toThrow(/broken\.json/);
  });

  it("skips scrape outputs that fail schema validation and continues with the rest", async () => {
    const dir = tmpDir();
    const inputDir = join(dir, "in");
    const outputDir = join(dir, "out");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "good.json"), JSON.stringify(emptyOutput()));
    writeFileSync(join(inputDir, "schema-bad.json"), JSON.stringify({ ats: "greenhouse" }));
    const code = await runBuildDbCommand([
      "--input",
      inputDir,
      "--output-dir",
      outputDir,
      "--short-sha",
      "abc1234",
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(outputDir, "jobs.abc1234.sqlite"))).toBe(true);
  });

  it("rejects --stale-ttl-days outside [1, 14]", async () => {
    const dir = tmpDir();
    const inputDir = join(dir, "in");
    const outputDir = join(dir, "out");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "out.json"), JSON.stringify(emptyOutput()));
    const code = await runBuildDbCommand([
      "--input",
      inputDir,
      "--output-dir",
      outputDir,
      "--short-sha",
      "abc1234",
      "--stale-ttl-days",
      "99",
    ]);
    expect(code).toBe(2);
  });

  it("accepts a valid --stale-ttl-days and forwards it to build-db", async () => {
    const dir = tmpDir();
    const inputDir = join(dir, "in");
    const outputDir = join(dir, "out");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "out.json"), JSON.stringify(emptyOutput()));
    const code = await runBuildDbCommand([
      "--input",
      inputDir,
      "--output-dir",
      outputDir,
      "--short-sha",
      "abc1234",
      "--stale-ttl-days",
      "5",
    ]);
    expect(code).toBe(0);
  });

  it("dispatches build-db via main() too", async () => {
    const dir = tmpDir();
    const inputDir = join(dir, "in");
    const outputDir = join(dir, "out");
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "out.json"), JSON.stringify(emptyOutput()));
    const code = await main([
      "bun",
      "cli.ts",
      "build-db",
      "--input",
      inputDir,
      "--output-dir",
      outputDir,
      "--short-sha",
      "abc1234",
    ]);
    expect(code).toBe(0);
  });
});

describe("runHarvestCommand", () => {
  it("returns 0 on --help", async () => {
    expect(await runHarvestCommand(["--help"])).toBe(0);
  });

  it("returns 2 when --ats is missing", async () => {
    expect(await runHarvestCommand(["--snapshots", "2026-13"])).toBe(2);
  });

  it("returns 2 when --ats is unknown", async () => {
    expect(await runHarvestCommand(["--ats", "rippling", "--snapshots", "2026-13"])).toBe(2);
  });

  it("returns 2 when neither --user-agent nor --contact-url is given", async () => {
    expect(await runHarvestCommand(["--ats", "greenhouse", "--snapshots", "2026-13"])).toBe(2);
  });

  it("returns 2 when --snapshots is empty after parsing", async () => {
    expect(
      await runHarvestCommand([
        "--ats",
        "greenhouse",
        "--snapshots",
        " , ",
        "--contact-url",
        "https://example.invalid/contact",
      ]),
    ).toBe(2);
  });

  it("returns 2 when a snapshot id has the wrong format", async () => {
    expect(
      await runHarvestCommand([
        "--ats",
        "greenhouse",
        "--snapshots",
        "2026-13a",
        "--contact-url",
        "https://example.invalid/contact",
      ]),
    ).toBe(2);
  });

  it("writes tenants/{ats}.json on the happy path with --skip-probe", async () => {
    const originalFetch = globalThis.fetch;
    const cdxCalls: string[] = [];
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (urlHostMatches(u, "commoncrawl.org")) {
        cdxCalls.push(u);
        if (u.includes("showNumPages")) return new Response("1", { status: 200 });
        return new Response(
          [
            '{"url":"https://boards.greenhouse.io/stripe","status":"200","timestamp":"2026"}',
            '{"url":"https://boards.greenhouse.io/anthropic","status":"200","timestamp":"2026"}',
          ].join("\n"),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    };
    try {
      const dir = tmpDir();
      const code = await runHarvestCommand([
        "--ats",
        "greenhouse",
        "--snapshots",
        "2026-13",
        "--output-dir",
        dir,
        "--skip-probe",
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
      expect(cdxCalls.some((u) => u.includes("CC-MAIN-2026-13-index"))).toBe(true);
      const path = join(dir, "tenants", "greenhouse.json");
      expect(existsSync(path)).toBe(true);
      const tenants = JSON.parse(readFileSync(path, "utf8")) as Array<{ slug: string }>;
      expect(tenants.map((t) => t.slug).sort()).toEqual(["anthropic", "stripe"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves the latest snapshots from collinfo.json when --snapshots is omitted", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u.endsWith("/collinfo.json")) {
        return new Response(
          JSON.stringify([
            { id: "CC-MAIN-2026-13", name: "March/April 2026" },
            { id: "CC-MAIN-2025-50", name: "December 2025" },
            { id: "CC-MAIN-2025-39", name: "September 2025" },
            { id: "CC-MAIN-2025-26", name: "June 2025" },
            { id: "CC-MAIN-2025-13", name: "March 2025" },
          ]),
          { status: 200 },
        );
      }
      if (u.includes("showNumPages")) return new Response("1", { status: 200 });
      return new Response("", { status: 200 });
    };
    try {
      const dir = tmpDir();
      const code = await runHarvestCommand([
        "--ats",
        "greenhouse",
        "--output-dir",
        dir,
        "--skip-probe",
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
      expect(existsSync(join(dir, "tenants", "greenhouse.json"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 2 when collinfo.json yields no usable ids", async () => {
    // Pin --output-dir to a fresh temp directory so the test doesn't
    // accidentally read the workspace's real `data/harvest-state/_collinfo.json`
    // cache (which has real CC content). Before the workspace-rooted
    // default-output-dir fix, `./data` was cwd-relative and usually
    // empty, but now it always resolves to the real workspace dir.
    const dir = tmpDir();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u.endsWith("/collinfo.json")) return new Response("[]", { status: 200 });
      return new Response("", { status: 200 });
    };
    try {
      const code = await runHarvestCommand([
        "--ats",
        "greenhouse",
        "--output-dir",
        dir,
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dispatches harvest via main() too", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("", { status: 404 });
    try {
      const dir = tmpDir();
      const code = await main([
        "bun",
        "cli.ts",
        "harvest",
        "--ats",
        "greenhouse",
        "--snapshots",
        "2026-13",
        "--output-dir",
        dir,
        "--skip-probe",
        "--user-agent",
        "openroles-test/0.0.0 (+https://example.invalid)",
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("supports --snapshots-since to bootstrap from a starting year", async () => {
    const originalFetch = globalThis.fetch;
    const cdxUrls: string[] = [];
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u.endsWith("/collinfo.json")) {
        return new Response(
          JSON.stringify([
            { id: "CC-MAIN-2026-13" },
            { id: "CC-MAIN-2020-15" },
            { id: "CC-MAIN-2008-30" },
          ]),
          { status: 200 },
        );
      }
      if (u.includes("showNumPages")) return new Response("1", { status: 200 });
      if (u.includes("CC-MAIN")) {
        cdxUrls.push(u);
      }
      return new Response("", { status: 200 });
    };
    try {
      const dir = tmpDir();
      const code = await runHarvestCommand([
        "--ats",
        "greenhouse",
        "--snapshots-since",
        "2020",
        "--output-dir",
        dir,
        "--skip-probe",
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
      expect(cdxUrls.some((u) => u.includes("CC-MAIN-2026-13"))).toBe(true);
      expect(cdxUrls.some((u) => u.includes("CC-MAIN-2020-15"))).toBe(true);
      expect(cdxUrls.some((u) => u.includes("CC-MAIN-2008-30"))).toBe(false);
      const statePath = join(dir, "harvest-state", "greenhouse.json");
      expect(existsSync(statePath)).toBe(true);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.snapshots_processed.sort()).toEqual(["2020-15", "2026-13"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects --snapshots-since with a year before 2008", async () => {
    const code = await runHarvestCommand([
      "--ats",
      "greenhouse",
      "--snapshots-since",
      "1999",
      "--user-agent",
      "openroles-test/0.0.0 (+https://example.invalid)",
    ]);
    expect(code).toBe(2);
  });

  it("rejects a state file whose ats doesn't match --ats", async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "harvest-state"), { recursive: true });
    writeFileSync(
      join(dir, "harvest-state", "greenhouse.json"),
      JSON.stringify({
        schema_version: "1.0.0",
        ats: "lever",
        snapshots_processed: [],
        tenant_count: 0,
        last_updated_at: "2026-04-30T00:00:00Z",
      }),
    );
    await expect(
      runHarvestCommand([
        "--ats",
        "greenhouse",
        "--output-dir",
        dir,
        "--snapshots",
        "2026-13",
        "--skip-probe",
        "--contact-url",
        "https://example.invalid/contact",
      ]),
    ).rejects.toThrow(/state file.*is for ats=lever/);
  });

  it("rejects a state file with malformed JSON", async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "harvest-state"), { recursive: true });
    writeFileSync(join(dir, "harvest-state", "greenhouse.json"), "{not json");
    await expect(
      runHarvestCommand([
        "--ats",
        "greenhouse",
        "--output-dir",
        dir,
        "--snapshots",
        "2026-13",
        "--skip-probe",
        "--contact-url",
        "https://example.invalid/contact",
      ]),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a state file that fails schema validation", async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "harvest-state"), { recursive: true });
    writeFileSync(
      join(dir, "harvest-state", "greenhouse.json"),
      JSON.stringify({ schema_version: "9.9.9", ats: "greenhouse" }),
    );
    await expect(
      runHarvestCommand([
        "--ats",
        "greenhouse",
        "--output-dir",
        dir,
        "--snapshots",
        "2026-13",
        "--skip-probe",
        "--contact-url",
        "https://example.invalid/contact",
      ]),
    ).rejects.toThrow(/failed schema validation/);
  });

  it("--incremental returns 2 when no state file exists yet", async () => {
    const dir = tmpDir();
    const code = await runHarvestCommand([
      "--ats",
      "greenhouse",
      "--incremental",
      "--output-dir",
      dir,
      "--user-agent",
      "openroles-test/0.0.0 (+https://example.invalid)",
    ]);
    expect(code).toBe(2);
  });

  it("--incremental processes only snapshots not in the state file", async () => {
    const originalFetch = globalThis.fetch;
    const cdxUrls: string[] = [];
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u.endsWith("/collinfo.json")) {
        return new Response(
          JSON.stringify([
            { id: "CC-MAIN-2026-26" },
            { id: "CC-MAIN-2026-13" },
            { id: "CC-MAIN-2025-50" },
          ]),
          { status: 200 },
        );
      }
      if (u.includes("showNumPages")) return new Response("1", { status: 200 });
      if (u.includes("CC-MAIN")) {
        cdxUrls.push(u);
      }
      return new Response("", { status: 200 });
    };
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "harvest-state"), { recursive: true });
      writeFileSync(
        join(dir, "harvest-state", "greenhouse.json"),
        JSON.stringify({
          schema_version: "1.0.0",
          ats: "greenhouse",
          snapshots_processed: ["2025-50", "2026-13"],
          tenant_count: 0,
          last_updated_at: "2026-04-30T00:00:00Z",
        }),
      );
      const code = await runHarvestCommand([
        "--ats",
        "greenhouse",
        "--incremental",
        "--output-dir",
        dir,
        "--skip-probe",
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
      // Only 2026-26 (the new one) should have been processed.
      expect(cdxUrls.some((u) => u.includes("CC-MAIN-2026-26"))).toBe(true);
      expect(cdxUrls.some((u) => u.includes("CC-MAIN-2026-13"))).toBe(false);
      expect(cdxUrls.some((u) => u.includes("CC-MAIN-2025-50"))).toBe(false);
      const state = JSON.parse(readFileSync(join(dir, "harvest-state", "greenhouse.json"), "utf8"));
      expect(state.snapshots_processed.sort()).toEqual(["2025-50", "2026-13", "2026-26"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("--incremental returns 0 with a notice when no new snapshots remain", async () => {
    const originalFetch = globalThis.fetch;
    let cdxAttempts = 0;
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u.endsWith("/collinfo.json")) {
        return new Response(JSON.stringify([{ id: "CC-MAIN-2026-13" }]), { status: 200 });
      }
      if (u.includes("CC-MAIN")) cdxAttempts += 1;
      return new Response("", { status: 200 });
    };
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "harvest-state"), { recursive: true });
      writeFileSync(
        join(dir, "harvest-state", "greenhouse.json"),
        JSON.stringify({
          schema_version: "1.0.0",
          ats: "greenhouse",
          snapshots_processed: ["2026-13"],
          tenant_count: 0,
          last_updated_at: "2026-04-30T00:00:00Z",
        }),
      );
      const code = await runHarvestCommand([
        "--ats",
        "greenhouse",
        "--incremental",
        "--output-dir",
        dir,
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
      expect(cdxAttempts).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("merges existing tenants with newly-discovered ones (additive)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u.includes("showNumPages")) return new Response("1", { status: 200 });
      if (u.includes("CC-MAIN")) {
        return new Response(
          [
            '{"url":"https://boards.greenhouse.io/newco","status":"200","timestamp":"20260101000000"}',
            "",
          ].join("\n"),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    };
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "tenants"), { recursive: true });
      writeFileSync(
        join(dir, "tenants", "greenhouse.json"),
        JSON.stringify([
          {
            ats: "greenhouse",
            slug: "stripe",
            status: "live",
            last_probed_at: "2026-04-01T00:00:00Z",
            first_seen_at: "2024-01-01T00:00:00Z",
          },
        ]),
      );
      const code = await runHarvestCommand([
        "--ats",
        "greenhouse",
        "--snapshots",
        "2026-13",
        "--output-dir",
        dir,
        "--skip-probe",
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
      const tenants = JSON.parse(
        readFileSync(join(dir, "tenants", "greenhouse.json"), "utf8"),
      ) as Array<{ slug: string; status: string; last_probed_at: string }>;
      expect(tenants.map((t) => t.slug).sort()).toEqual(["newco", "stripe"]);
      const stripe = tenants.find((t) => t.slug === "stripe");
      expect(stripe?.status).toBe("live");
      expect(stripe?.last_probed_at).toBe("2026-04-01T00:00:00Z");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("runReprobeCommand", () => {
  it("returns 0 on --help", async () => {
    expect(await runReprobeCommand(["--help"])).toBe(0);
  });

  it("returns 2 when --ats is missing", async () => {
    expect(await runReprobeCommand([])).toBe(2);
  });

  it("returns 2 when --ats is unknown", async () => {
    expect(await runReprobeCommand(["--ats", "rippling"])).toBe(2);
  });

  it("returns 2 when neither --user-agent nor --contact-url is set", async () => {
    expect(await runReprobeCommand(["--ats", "greenhouse"])).toBe(2);
  });

  it("returns 2 when --max-age-days is out of range", async () => {
    expect(
      await runReprobeCommand([
        "--ats",
        "greenhouse",
        "--contact-url",
        "https://example.invalid/contact",
        "--max-age-days",
        "999",
      ]),
    ).toBe(2);
  });

  it("returns 2 when --batch-size is out of range", async () => {
    expect(
      await runReprobeCommand([
        "--ats",
        "greenhouse",
        "--contact-url",
        "https://example.invalid/contact",
        "--batch-size",
        "0",
      ]),
    ).toBe(2);
  });

  it("returns 0 with a notice when no tenants file exists", async () => {
    const dir = tmpDir();
    const code = await runReprobeCommand([
      "--ats",
      "greenhouse",
      "--output-dir",
      dir,
      "--contact-url",
      "https://example.invalid/contact",
    ]);
    expect(code).toBe(0);
  });

  it("re-probes only stale tenants and updates their status in place", async () => {
    const originalFetch = globalThis.fetch;
    const probedSlugs: string[] = [];
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (urlHostIs(u, "boards-api.greenhouse.io")) {
        const m = u.match(/\/boards\/([^/]+)\/jobs/);
        if (m?.[1]) probedSlugs.push(m[1]);
        return new Response("[]", { status: 200 });
      }
      return new Response("", { status: 200 });
    };
    try {
      const dir = tmpDir();
      const old = "2026-01-01T00:00:00Z"; // stale
      const fresh = new Date().toISOString(); // not stale
      mkdirSync(join(dir, "tenants"), { recursive: true });
      writeFileSync(
        join(dir, "tenants", "greenhouse.json"),
        JSON.stringify([
          {
            ats: "greenhouse",
            slug: "old-tenant",
            status: "transient_failure",
            last_probed_at: old,
            first_seen_at: "2024-01-01T00:00:00Z",
          },
          {
            ats: "greenhouse",
            slug: "fresh-tenant",
            status: "live",
            last_probed_at: fresh,
            first_seen_at: "2024-01-01T00:00:00Z",
          },
        ]),
      );
      const code = await runReprobeCommand([
        "--ats",
        "greenhouse",
        "--output-dir",
        dir,
        "--max-age-days",
        "7",
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
      expect(probedSlugs).toEqual(["old-tenant"]);
      const updated = JSON.parse(
        readFileSync(join(dir, "tenants", "greenhouse.json"), "utf8"),
      ) as Array<{ slug: string; status: string; last_probed_at: string }>;
      const oldTenant = updated.find((t) => t.slug === "old-tenant");
      expect(oldTenant?.status).toBe("live");
      expect(oldTenant?.last_probed_at).not.toBe(old);
      const freshTenant = updated.find((t) => t.slug === "fresh-tenant");
      expect(freshTenant?.last_probed_at).toBe(fresh);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 0 when nothing is older than --max-age-days", async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "tenants"), { recursive: true });
    writeFileSync(
      join(dir, "tenants", "greenhouse.json"),
      JSON.stringify([
        {
          ats: "greenhouse",
          slug: "fresh",
          status: "live",
          last_probed_at: new Date().toISOString(),
          first_seen_at: "2024-01-01T00:00:00Z",
        },
      ]),
    );
    const code = await runReprobeCommand([
      "--ats",
      "greenhouse",
      "--output-dir",
      dir,
      "--max-age-days",
      "7",
      "--contact-url",
      "https://example.invalid/contact",
    ]);
    expect(code).toBe(0);
  });

  // Mass-failure guard: a transient host/network incident that flips a large
  // share of a connector's live tenants to dead in one run must not be
  // persisted as `dead` — those tenants are demoted to transient_failure.
  // Uses bamboohr (per-subdomain host, no inter-probe delay) so even a
  // few-hundred-tenant reprobe completes instantly against the mocked fetch.
  function writeLiveBamboo(dir: string, slugs: ReadonlyArray<string>): void {
    const old = "2026-01-01T00:00:00Z"; // stale → eligible for reprobe
    mkdirSync(join(dir, "tenants"), { recursive: true });
    writeFileSync(
      join(dir, "tenants", "bamboohr.json"),
      JSON.stringify(
        slugs.map((slug) => ({
          ats: "bamboohr",
          slug,
          status: "live",
          last_probed_at: old,
          first_seen_at: "2024-01-01T00:00:00Z",
        })),
      ),
    );
  }
  // Mock fetch where bamboohr tenants in `deadSet` 404 (→ dead) and the rest 200.
  function bambooFetch(deadSet: ReadonlySet<string>): typeof globalThis.fetch {
    return async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      const m = u.match(/^https:\/\/([^.]+)\.bamboohr\.com/);
      if (m?.[1]) {
        return deadSet.has(m[1])
          ? new Response("nope", { status: 404 })
          : new Response('{"result":[]}', { status: 200 });
      }
      return new Response("", { status: 200 });
    };
  }
  async function reprobeAll(dir: string): Promise<void> {
    await runReprobeCommand([
      "--ats",
      "bamboohr",
      "--output-dir",
      dir,
      "--max-age-days",
      "7",
      "--contact-url",
      "https://example.invalid/contact",
    ]);
  }
  function statusBySlug(dir: string): Map<string, string> {
    const rows = JSON.parse(readFileSync(join(dir, "tenants", "bamboohr.json"), "utf8")) as Array<{
      slug: string;
      status: string;
    }>;
    return new Map(rows.map((r) => [r.slug, r.status]));
  }

  it("demotes a mass live→dead flip to transient_failure (suspected incident)", async () => {
    const originalFetch = globalThis.fetch;
    const slugs = Array.from({ length: 60 }, (_, i) => `t${i}`);
    globalThis.fetch = bambooFetch(new Set(slugs)); // every tenant 404s
    try {
      const dir = tmpDir();
      writeLiveBamboo(dir, slugs);
      await reprobeAll(dir);
      const status = statusBySlug(dir);
      const dead = [...status.values()].filter((s) => s === "dead").length;
      const transient = [...status.values()].filter((s) => s === "transient_failure").length;
      expect(dead).toBe(0); // none persisted as dead
      expect(transient).toBe(60); // all demoted
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a small live→dead flip as dead (below the incident count floor)", async () => {
    const originalFetch = globalThis.fetch;
    const slugs = Array.from({ length: 10 }, (_, i) => `s${i}`);
    globalThis.fetch = bambooFetch(new Set(slugs)); // all 10 die, but < min count
    try {
      const dir = tmpDir();
      writeLiveBamboo(dir, slugs);
      await reprobeAll(dir);
      const status = statusBySlug(dir);
      expect([...status.values()].filter((s) => s === "dead").length).toBe(10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a minority live→dead flip as dead (below the incident fraction)", async () => {
    const originalFetch = globalThis.fetch;
    const slugs = Array.from({ length: 200 }, (_, i) => `u${i}`);
    const deadSlugs = slugs.slice(0, 60); // 60 die (≥ count floor) but < 50% of 200
    globalThis.fetch = bambooFetch(new Set(deadSlugs));
    try {
      const dir = tmpDir();
      writeLiveBamboo(dir, slugs);
      await reprobeAll(dir);
      const status = statusBySlug(dir);
      expect([...status.values()].filter((s) => s === "dead").length).toBe(60);
      expect([...status.values()].filter((s) => s === "live").length).toBe(140);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fires at exactly the count floor (50 live all dying)", async () => {
    const originalFetch = globalThis.fetch;
    const slugs = Array.from({ length: 50 }, (_, i) => `b${i}`);
    globalThis.fetch = bambooFetch(new Set(slugs)); // 50 == INCIDENT_MIN_LIVE_TO_DEAD
    try {
      const dir = tmpDir();
      writeLiveBamboo(dir, slugs);
      await reprobeAll(dir);
      const status = statusBySlug(dir);
      expect([...status.values()].filter((s) => s === "transient_failure").length).toBe(50);
      expect([...status.values()].filter((s) => s === "dead").length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("during an incident, demotes only live→dead — other statuses untouched", async () => {
    const originalFetch = globalThis.fetch;
    const live = Array.from({ length: 60 }, (_, i) => `lv${i}`); // all 404 → incident
    const deadSet = new Set([...live, "stays-dead"]); // a pre-existing dead that re-probes dead
    globalThis.fetch = bambooFetch(deadSet);
    try {
      const dir = tmpDir();
      const old = "2026-01-01T00:00:00Z";
      mkdirSync(join(dir, "tenants"), { recursive: true });
      const rows = [
        ...live.map((slug) => ({
          ats: "bamboohr",
          slug,
          status: "live",
          last_probed_at: old,
          first_seen_at: old,
        })),
        // already dead and re-probes dead → must stay dead, NOT swept into the demotion
        {
          ats: "bamboohr",
          slug: "stays-dead",
          status: "dead",
          last_probed_at: old,
          first_seen_at: old,
        },
        // re-probes 200 → a genuine dead→live recovery must still happen
        {
          ats: "bamboohr",
          slug: "recovers",
          status: "dead",
          last_probed_at: old,
          first_seen_at: old,
        },
      ];
      writeFileSync(join(dir, "tenants", "bamboohr.json"), JSON.stringify(rows));
      await reprobeAll(dir);
      const status = statusBySlug(dir);
      expect(live.every((s) => status.get(s) === "transient_failure")).toBe(true); // demoted
      expect(status.get("stays-dead")).toBe("dead"); // not swept into the demotion
      expect(status.get("recovers")).toBe("live"); // recovery not blocked by the guard
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("runDiscoverWorkdaySitesCommand", () => {
  it("returns 0 on --help", async () => {
    expect(await runDiscoverWorkdaySitesCommand(["--help"])).toBe(0);
  });

  it("returns 2 when neither --user-agent nor --contact-url is set", async () => {
    expect(await runDiscoverWorkdaySitesCommand([])).toBe(2);
  });

  it("returns 2 when --batch-size is out of range", async () => {
    expect(
      await runDiscoverWorkdaySitesCommand([
        "--contact-url",
        "https://example.invalid/contact",
        "--batch-size",
        "9999",
      ]),
    ).toBe(2);
  });

  it("returns 2 when --concurrency is out of range", async () => {
    expect(
      await runDiscoverWorkdaySitesCommand([
        "--contact-url",
        "https://example.invalid/contact",
        "--concurrency",
        "0",
      ]),
    ).toBe(2);
  });

  it("returns 0 with a notice when no tenants file exists", async () => {
    const dir = tmpDir();
    const code = await runDiscoverWorkdaySitesCommand([
      "--output-dir",
      dir,
      "--contact-url",
      "https://example.invalid/contact",
    ]);
    expect(code).toBe(0);
  });

  it("discovers site from robots.txt Allow directive and writes back atomically", async () => {
    const originalFetch = globalThis.fetch;
    const probedHosts: string[] = [];
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u === "https://att.wd1.myworkdayjobs.com/robots.txt") {
        probedHosts.push("att");
        return new Response(
          `User-agent: *\nAllow: /ATTGeneral/\nAllow: /Cricket/\nSitemap: https://att.wd1.myworkdayjobs.com/ATTGeneral/siteMap.xml`,
          { status: 200 },
        );
      }
      if (u === "https://comcast.wd5.myworkdayjobs.com/robots.txt") {
        probedHosts.push("comcast");
        return new Response(`User-agent: *\nAllow: /Comcast_Careers/\n`, { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "tenants"), { recursive: true });
      writeFileSync(
        join(dir, "tenants", "workday.json"),
        JSON.stringify([
          {
            ats: "workday",
            slug: "att",
            status: "live",
            last_probed_at: "2026-01-01T00:00:00Z",
            metadata: { host: "att.wd1.myworkdayjobs.com" },
          },
          {
            ats: "workday",
            slug: "comcast",
            status: "live",
            last_probed_at: "2026-01-01T00:00:00Z",
            metadata: { host: "comcast.wd5.myworkdayjobs.com" },
          },
        ]),
      );
      const code = await runDiscoverWorkdaySitesCommand([
        "--output-dir",
        dir,
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
      expect(probedHosts.sort()).toEqual(["att", "comcast"]);
      const updated = JSON.parse(
        readFileSync(join(dir, "tenants", "workday.json"), "utf8"),
      ) as Array<{ slug: string; metadata?: { host?: string; site?: string } }>;
      const att = updated.find((t) => t.slug === "att");
      // ATTGeneral wins on keyword scoring (+5 for "general", token
      // match), not first-Allow order — ATTCollege precedes it in the
      // fixture above. Cricket (no scored keyword) ties at 0 but
      // ATTGeneral's +5 wins outright.
      expect(att?.metadata?.site).toBe("ATTGeneral");
      // Original host metadata is preserved.
      expect(att?.metadata?.host).toBe("att.wd1.myworkdayjobs.com");
      const comcast = updated.find((t) => t.slug === "comcast");
      expect(comcast?.metadata?.site).toBe("Comcast_Careers");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips tenants whose metadata.site is already set unless --force-rediscover", async () => {
    const originalFetch = globalThis.fetch;
    const probedHosts: string[] = [];
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      // Host-suffix match on the parsed host, not a substring of the
      // raw URL — satisfies codeql/js/incomplete-url-substring-
      // sanitization and rules out spoofers like
      // `evil.com/?x=foo.myworkdayjobs.com`.
      let host = "";
      try {
        host = new URL(u).host;
      } catch {}
      if (u.endsWith("/robots.txt") && host.endsWith(".myworkdayjobs.com")) {
        probedHosts.push(u);
        return new Response(`User-agent: *\nAllow: /ATTGeneral/\n`, { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "tenants"), { recursive: true });
      writeFileSync(
        join(dir, "tenants", "workday.json"),
        JSON.stringify([
          {
            ats: "workday",
            slug: "att",
            status: "live",
            last_probed_at: "2026-01-01T00:00:00Z",
            metadata: { host: "att.wd1.myworkdayjobs.com", site: "OldSite" },
          },
        ]),
      );
      const code = await runDiscoverWorkdaySitesCommand([
        "--output-dir",
        dir,
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
      // No fetch happened because the only tenant already had a site.
      expect(probedHosts).toEqual([]);
      const updated = JSON.parse(
        readFileSync(join(dir, "tenants", "workday.json"), "utf8"),
      ) as Array<{ slug: string; metadata?: { site?: string } }>;
      expect(updated[0]?.metadata?.site).toBe("OldSite");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("--force-rediscover overrides existing metadata.site", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u === "https://att.wd1.myworkdayjobs.com/robots.txt") {
        return new Response(`User-agent: *\nAllow: /NewSite/\n`, { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "tenants"), { recursive: true });
      writeFileSync(
        join(dir, "tenants", "workday.json"),
        JSON.stringify([
          {
            ats: "workday",
            slug: "att",
            status: "live",
            last_probed_at: "2026-01-01T00:00:00Z",
            metadata: { host: "att.wd1.myworkdayjobs.com", site: "OldSite" },
          },
        ]),
      );
      const code = await runDiscoverWorkdaySitesCommand([
        "--output-dir",
        dir,
        "--contact-url",
        "https://example.invalid/contact",
        "--force-rediscover",
      ]);
      expect(code).toBe(0);
      const updated = JSON.parse(
        readFileSync(join(dir, "tenants", "workday.json"), "utf8"),
      ) as Array<{ slug: string; metadata?: { site?: string } }>;
      expect(updated[0]?.metadata?.site).toBe("NewSite");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves tenants unchanged when robots.txt has no Allow directive", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) {
        // empty robots.txt — discovery returns null
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "tenants"), { recursive: true });
      writeFileSync(
        join(dir, "tenants", "workday.json"),
        JSON.stringify([
          {
            ats: "workday",
            slug: "spectrum",
            status: "live",
            last_probed_at: "2026-01-01T00:00:00Z",
            metadata: { host: "spectrum.wd1.myworkdayjobs.com" },
          },
        ]),
      );
      const code = await runDiscoverWorkdaySitesCommand([
        "--output-dir",
        dir,
        "--contact-url",
        "https://example.invalid/contact",
      ]);
      expect(code).toBe(0);
      const updated = JSON.parse(
        readFileSync(join(dir, "tenants", "workday.json"), "utf8"),
      ) as Array<{ slug: string; metadata?: { site?: string } }>;
      // Site stays unset; the row is otherwise untouched.
      expect(updated[0]?.metadata?.site).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("respects --batch-size and processes only the first N candidates", async () => {
    const originalFetch = globalThis.fetch;
    const probedHosts: string[] = [];
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      // Host-suffix match on parsed host (see sibling test for rationale —
      // codeql/js/incomplete-url-substring-sanitization).
      let host = "";
      try {
        host = new URL(u).host;
      } catch {}
      if (u.endsWith("/robots.txt") && host.endsWith(".myworkdayjobs.com")) {
        probedHosts.push(u);
        return new Response(`User-agent: *\nAllow: /External/\n`, { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "tenants"), { recursive: true });
      writeFileSync(
        join(dir, "tenants", "workday.json"),
        JSON.stringify([
          {
            ats: "workday",
            slug: "alpha",
            status: "live",
            last_probed_at: "2026-01-01T00:00:00Z",
            metadata: { host: "alpha.wd1.myworkdayjobs.com" },
          },
          {
            ats: "workday",
            slug: "beta",
            status: "live",
            last_probed_at: "2026-01-01T00:00:00Z",
            metadata: { host: "beta.wd1.myworkdayjobs.com" },
          },
          {
            ats: "workday",
            slug: "gamma",
            status: "live",
            last_probed_at: "2026-01-01T00:00:00Z",
            metadata: { host: "gamma.wd1.myworkdayjobs.com" },
          },
        ]),
      );
      const code = await runDiscoverWorkdaySitesCommand([
        "--output-dir",
        dir,
        "--contact-url",
        "https://example.invalid/contact",
        "--batch-size",
        "2",
      ]);
      expect(code).toBe(0);
      // Slug-ordered batching: alpha + beta first, gamma deferred.
      expect(probedHosts).toHaveLength(2);
      expect(probedHosts.some((u) => u.includes("alpha.wd1"))).toBe(true);
      expect(probedHosts.some((u) => u.includes("beta.wd1"))).toBe(true);
      expect(probedHosts.some((u) => u.includes("gamma.wd1"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("runDiscoverGjobsfeedCommand", () => {
  const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>x</title></channel></rss>`;
  const URLSET = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;

  function writeCandidates(dir: string, list: unknown): string {
    const p = join(dir, "gjobsfeed-candidates.json");
    writeFileSync(p, JSON.stringify(list));
    return p;
  }

  it("returns 0 on --help", async () => {
    expect(await runDiscoverGjobsfeedCommand(["--help"])).toBe(0);
  });

  it("returns 2 without --user-agent / --contact-url", async () => {
    expect(await runDiscoverGjobsfeedCommand([])).toBe(2);
  });

  it("returns 2 on out-of-range --batch-size and --concurrency", async () => {
    expect(
      await runDiscoverGjobsfeedCommand([
        "--contact-url",
        "https://e.invalid",
        "--batch-size",
        "0",
      ]),
    ).toBe(2);
    expect(
      await runDiscoverGjobsfeedCommand([
        "--contact-url",
        "https://e.invalid",
        "--concurrency",
        "99",
      ]),
    ).toBe(2);
  });

  it("returns 2 when the candidate list is missing", async () => {
    const dir = tmpDir();
    expect(
      await runDiscoverGjobsfeedCommand([
        "--output-dir",
        dir,
        "--contact-url",
        "https://e.invalid",
      ]),
    ).toBe(2);
  });

  it("returns 0 when the candidate list is an empty array", async () => {
    const dir = tmpDir();
    writeCandidates(dir, []);
    expect(
      await runDiscoverGjobsfeedCommand([
        "--output-dir",
        dir,
        "--contact-url",
        "https://e.invalid",
      ]),
    ).toBe(0);
  });

  it("discovers a feed, skips a urlset host, dedups vs another live ATS, is idempotent", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u === "https://jobs.acme.com/sitemap.xml")
        return new Response(RSS, { status: 200, headers: { "content-type": "application/xml" } });
      if (u === "https://jobs.plain.com/sitemap.xml")
        return new Response(URLSET, {
          status: 200,
          headers: { "content-type": "application/xml" },
        });
      return new Response("", { status: 404 });
    };
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "tenants"), { recursive: true });
      // `dup` is already live under workday → must be skipped by guard.
      writeFileSync(
        join(dir, "tenants", "workday.json"),
        JSON.stringify([
          {
            ats: "workday",
            slug: "dup",
            status: "live",
            last_probed_at: "2026-01-01T00:00:00Z",
            metadata: { host: "dup.wd1.myworkdayjobs.com" },
          },
        ]),
      );
      writeCandidates(dir, [
        { slug: "acme", display_name: "Acme", hosts: ["jobs.acme.com"] },
        { slug: "plain", display_name: "Plain Co", hosts: ["jobs.plain.com"] },
        { slug: "dup", display_name: "Dup Inc", hosts: ["jobs.acme.com"] },
      ]);
      const code = await runDiscoverGjobsfeedCommand([
        "--output-dir",
        dir,
        "--contact-url",
        "https://e.invalid",
      ]);
      expect(code).toBe(0);
      const seeded = JSON.parse(
        readFileSync(join(dir, "tenants", "gjobsfeed.json"), "utf8"),
      ) as Array<{ slug: string; status: string; metadata?: { feed_url?: string } }>;
      // Only acme is seeded: plain serves a urlset (no signature), dup
      // is live elsewhere (dedup guard).
      expect(seeded.map((t) => t.slug)).toEqual(["acme"]);
      expect(seeded[0]?.status).toBe("transient_failure");
      expect(seeded[0]?.metadata?.feed_url).toBe("https://jobs.acme.com/sitemap.xml");

      // Idempotent: a second run with acme already seeded adds nothing.
      const code2 = await runDiscoverGjobsfeedCommand([
        "--output-dir",
        dir,
        "--contact-url",
        "https://e.invalid",
      ]);
      expect(code2).toBe(0);
      const seeded2 = JSON.parse(
        readFileSync(join(dir, "tenants", "gjobsfeed.json"), "utf8"),
      ) as Array<{ slug: string }>;
      expect(seeded2.map((t) => t.slug)).toEqual(["acme"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("never fetches an unsafe host (SSRF guard short-circuits before client.request)", async () => {
    const originalFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      fetched.push(u);
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(RSS, { status: 200, headers: { "content-type": "application/xml" } });
    };
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "tenants"), { recursive: true });
      writeCandidates(dir, [
        { slug: "loop", display_name: "Loopback", hosts: ["localhost"] },
        { slug: "ipv4", display_name: "Metadata v4", hosts: ["169.254.169.254"] },
        { slug: "ipv6", display_name: "Loopback v6", hosts: ["[::1]"] },
        { slug: "ipv6meta", display_name: "Mapped meta", hosts: ["[::ffff:169.254.169.254]"] },
        { slug: "intl", display_name: "Internal", hosts: ["feed.internal"] },
      ]);
      const code = await runDiscoverGjobsfeedCommand([
        "--output-dir",
        dir,
        "--contact-url",
        "https://e.invalid",
      ]);
      expect(code).toBe(0);
      // No sitemap.xml request fired for any unsafe host — isSafeFetchHost
      // rejects before client.request. Nothing seeded.
      expect(fetched.some((u) => u.includes("/sitemap.xml"))).toBe(false);
      expect(existsSync(join(dir, "tenants", "gjobsfeed.json"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("runEnumerateGjobsfeedHostsCommand", () => {
  it("returns 0 on --help", async () => {
    expect(await runEnumerateGjobsfeedHostsCommand(["--help"])).toBe(0);
  });

  it("returns 2 without a valid --snapshots crawl id", async () => {
    expect(await runEnumerateGjobsfeedHostsCommand([])).toBe(2);
    expect(await runEnumerateGjobsfeedHostsCommand(["--snapshots", "latest"])).toBe(2);
    expect(await runEnumerateGjobsfeedHostsCommand(["--snapshots", "CC-MAIN-2026-17'; --"])).toBe(
      2,
    );
  });

  it("returns 2 with a clear error when duckdb is not on PATH", async () => {
    const originalWhich = Bun.which;
    (Bun as { which: typeof Bun.which }).which = () => null;
    try {
      const code = await runEnumerateGjobsfeedHostsCommand(["--snapshots", "CC-MAIN-2026-17"]);
      expect(code).toBe(2);
    } finally {
      (Bun as { which: typeof Bun.which }).which = originalWhich;
    }
  });

  it("runs duckdb, merges enumerated hosts into the candidate list, idempotent", async () => {
    const originalWhich = Bun.which;
    const originalSpawn = Bun.spawn;
    (Bun as { which: typeof Bun.which }).which = () => "/usr/bin/duckdb";
    const csv = "url_host_name\njobs.acme.com\ncareers.acme.com\njobs.molsoncoors.com\nnodot\n";
    (Bun as { spawn: typeof Bun.spawn }).spawn = (() => ({
      stdout: new Response(csv).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    })) as unknown as typeof Bun.spawn;
    try {
      const dir = tmpDir();
      writeFileSync(
        join(dir, "gjobsfeed-candidates.json"),
        JSON.stringify([{ slug: "sap", display_name: "SAP", hosts: ["jobs.sap.com"] }]),
      );
      const code = await runEnumerateGjobsfeedHostsCommand([
        "--snapshots",
        "CC-MAIN-2026-17",
        "--output-dir",
        dir,
      ]);
      expect(code).toBe(0);
      const merged = JSON.parse(
        readFileSync(join(dir, "gjobsfeed-candidates.json"), "utf8"),
      ) as Array<{ slug: string; hosts: string[] }>;
      expect(merged.map((c) => c.slug).sort()).toEqual(["acme", "molsoncoors", "sap"]);
      const acme = merged.find((c) => c.slug === "acme");
      expect(acme?.hosts.sort()).toEqual(["careers.acme.com", "jobs.acme.com"]);

      // Idempotent re-run: same hosts, no change.
      const before = readFileSync(join(dir, "gjobsfeed-candidates.json"), "utf8");
      const code2 = await runEnumerateGjobsfeedHostsCommand([
        "--snapshots",
        "CC-MAIN-2026-17",
        "--output-dir",
        dir,
      ]);
      expect(code2).toBe(0);
      expect(readFileSync(join(dir, "gjobsfeed-candidates.json"), "utf8")).toBe(before);
    } finally {
      (Bun as { which: typeof Bun.which }).which = originalWhich;
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  it("returns 1 when duckdb exits non-zero", async () => {
    const originalWhich = Bun.which;
    const originalSpawn = Bun.spawn;
    (Bun as { which: typeof Bun.which }).which = () => "/usr/bin/duckdb";
    (Bun as { spawn: typeof Bun.spawn }).spawn = (() => ({
      stdout: new Response("").body,
      stderr: new Response("IO Error: s3 access denied").body,
      exited: Promise.resolve(1),
    })) as unknown as typeof Bun.spawn;
    try {
      const dir = tmpDir();
      writeFileSync(join(dir, "gjobsfeed-candidates.json"), "[]");
      const code = await runEnumerateGjobsfeedHostsCommand([
        "--snapshots",
        "CC-MAIN-2026-17",
        "--output-dir",
        dir,
      ]);
      expect(code).toBe(1);
    } finally {
      (Bun as { which: typeof Bun.which }).which = originalWhich;
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });
});

describe("runDiscoverSitemapCommand", () => {
  const ISOLVED_INDEX = `<?xml version='1.0' encoding='UTF-8'?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://davidsonoil.isolvedhire.com/job_site_map.xml</loc></sitemap><sitemap><loc>https://acmefresh.isolvedhire.com/job_site_map.xml</loc></sitemap><sitemap><loc>https://feeds.isolvedhire.com/site_map_index.xml</loc></sitemap></sitemapindex>`;
  const JAZZ_FEED = `<?xml version="1.0" encoding="utf-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://easeinc.applytojob.com/apply/x/Role</loc></url><url><loc>https://revived.applytojob.com/apply/y/Role</loc></url></urlset>`;

  it("returns 0 on --help", async () => {
    expect(await runDiscoverSitemapCommand(["--help"])).toBe(0);
  });

  it("returns 2 without --ats", async () => {
    expect(await runDiscoverSitemapCommand([])).toBe(2);
  });

  it("returns 2 for an unknown ats id", async () => {
    expect(await runDiscoverSitemapCommand(["--ats", "notreal"])).toBe(2);
  });

  it("returns 2 for a known ats with no sitemap source", async () => {
    expect(await runDiscoverSitemapCommand(["--ats", "greenhouse"])).toBe(2);
  });

  it("returns 2 on out-of-range --max", async () => {
    expect(await runDiscoverSitemapCommand(["--ats", "hiringthing", "--max", "0"])).toBe(2);
  });

  it("notes that --max is ignored for a non-descending source", async () => {
    const originalFetch = globalThis.fetch;
    const originalErr = console.error;
    const logs: string[] = [];
    console.error = (...a: unknown[]) => logs.push(a.join(" "));
    globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
    try {
      const dir = tmpDir();
      const code = await runDiscoverSitemapCommand([
        "--ats",
        "isolvedhire",
        "--output-dir",
        dir,
        "--max",
        "50",
      ]);
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes("--max is ignored for 'isolvedhire'"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalErr;
    }
  });

  it("honors a valid --max on the descending hiringthing source", async () => {
    const { gzipSync } = await import("node:zlib");
    const HT_INDEX = `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://s3.amazonaws.com/applicant-tracking-production-sitemap-us-east-1/sitemaps/cid_00000001_sitemap.xml.gz</loc></sitemap><sitemap><loc>https://s3.amazonaws.com/applicant-tracking-production-sitemap-us-east-1/sitemaps/cid_00000002_sitemap.xml.gz</loc></sitemap></sitemapindex>`;
    const HT_CHILD = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://acmeboard.hiringthing.com/job/1/role</loc></url></urlset>`;
    const gz = gzipSync(Buffer.from(HT_CHILD));
    const originalFetch = globalThis.fetch;
    const childCalls: string[] = [];
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.endsWith(".xml.gz")) {
        childCalls.push(u);
        return new Response(gz, { status: 200 });
      }
      return new Response(HT_INDEX, { status: 200 });
    }) as typeof fetch;
    try {
      const dir = tmpDir();
      const code = await runDiscoverSitemapCommand([
        "--ats",
        "hiringthing",
        "--output-dir",
        dir,
        "--max",
        "1",
      ]);
      expect(code).toBe(0);
      // --max 1 caps the descent to a single child.
      expect(childCalls.length).toBe(1);
      const out = JSON.parse(
        readFileSync(join(dir, "tenants", "hiringthing.json"), "utf8"),
      ) as Array<{ slug: string; status: string }>;
      expect(out.find((t) => t.slug === "acmeboard")?.status).toBe("transient_failure");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("seeds net-new isolvedhire slugs as transient_failure, skips the feed host", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(ISOLVED_INDEX, { status: 200 })) as typeof fetch;
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "tenants"), { recursive: true });
      // davidsonoil already live — must be preserved untouched.
      writeFileSync(
        join(dir, "tenants", "isolvedhire.json"),
        JSON.stringify([
          {
            ats: "isolvedhire",
            slug: "davidsonoil",
            status: "live",
            last_probed_at: "2026-01-01T00:00:00.000Z",
            first_seen_at: "2026-01-01T00:00:00.000Z",
          },
        ]),
      );
      const code = await runDiscoverSitemapCommand(["--ats", "isolvedhire", "--output-dir", dir]);
      expect(code).toBe(0);
      const out = JSON.parse(
        readFileSync(join(dir, "tenants", "isolvedhire.json"), "utf8"),
      ) as Array<{ slug: string; status: string }>;
      const bySlug = new Map(out.map((t) => [t.slug, t]));
      // acmefresh is net-new (transient_failure); davidsonoil preserved
      // live; feeds is deny-listed so never minted.
      expect(bySlug.get("acmefresh")?.status).toBe("transient_failure");
      expect(bySlug.get("davidsonoil")?.status).toBe("live");
      expect(bySlug.has("feeds")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resurrects a stale jazzhr slug (liveness-truth) for re-probe", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JAZZ_FEED, { status: 200 })) as typeof fetch;
    try {
      const dir = tmpDir();
      mkdirSync(join(dir, "tenants"), { recursive: true });
      writeFileSync(
        join(dir, "tenants", "jazzhr.json"),
        JSON.stringify([
          {
            ats: "jazzhr",
            slug: "revived",
            status: "dead",
            last_probed_at: "2026-06-01T00:00:00.000Z",
            first_seen_at: "2026-01-01T00:00:00.000Z",
          },
        ]),
      );
      const code = await runDiscoverSitemapCommand(["--ats", "jazzhr", "--output-dir", dir]);
      expect(code).toBe(0);
      const out = JSON.parse(readFileSync(join(dir, "tenants", "jazzhr.json"), "utf8")) as Array<{
        slug: string;
        status: string;
        last_probed_at: string;
      }>;
      const revived = out.find((t) => t.slug === "revived");
      // dead → transient_failure, last_probed_at reset to epoch.
      expect(revived?.status).toBe("transient_failure");
      expect(revived?.last_probed_at).toBe("1970-01-01T00:00:00.000Z");
      // easeinc is net-new.
      expect(out.find((t) => t.slug === "easeinc")?.status).toBe("transient_failure");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("--dry-run computes the summary without writing the tenant file", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(ISOLVED_INDEX, { status: 200 })) as typeof fetch;
    try {
      const dir = tmpDir();
      const code = await runDiscoverSitemapCommand([
        "--ats",
        "isolvedhire",
        "--output-dir",
        dir,
        "--dry-run",
      ]);
      expect(code).toBe(0);
      expect(existsSync(join(dir, "tenants", "isolvedhire.json"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("writes to --tenants-file when provided and is idempotent", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(ISOLVED_INDEX, { status: 200 })) as typeof fetch;
    try {
      const dir = tmpDir();
      const file = join(dir, "custom-isolved.json");
      const code = await runDiscoverSitemapCommand([
        "--ats",
        "isolvedhire",
        "--output-dir",
        dir,
        "--tenants-file",
        file,
      ]);
      expect(code).toBe(0);
      const first = readFileSync(file, "utf8");
      // Second run seeds nothing new → file content is unchanged.
      const code2 = await runDiscoverSitemapCommand([
        "--ats",
        "isolvedhire",
        "--output-dir",
        dir,
        "--tenants-file",
        file,
      ]);
      expect(code2).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(first);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 0 and writes nothing when the sitemap yields no slugs", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
    try {
      const dir = tmpDir();
      const code = await runDiscoverSitemapCommand(["--ats", "isolvedhire", "--output-dir", dir]);
      expect(code).toBe(0);
      expect(existsSync(join(dir, "tenants", "isolvedhire.json"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dispatches discover-sitemap via main() too", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
    try {
      const dir = tmpDir();
      const code = await main([
        "bun",
        "cli.ts",
        "discover-sitemap",
        "--ats",
        "isolvedhire",
        "--output-dir",
        dir,
      ]);
      expect(code).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
