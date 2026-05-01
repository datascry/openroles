import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  runBuildDbCommand,
  runHarvestCommand,
  runReportCommand,
  runReprobeCommand,
  runScrapeCommand,
} from "./cli.ts";

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
      if (u.includes("commoncrawl.org")) {
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
      if (u.includes("boards-api.greenhouse.io")) {
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
});
