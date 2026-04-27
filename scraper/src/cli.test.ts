import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, runBuildDbCommand, runScrapeCommand } from "./cli.ts";

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

  it("returns 2 for unimplemented commands", async () => {
    const code = await main(["bun", "cli.ts", "harvest"]);
    expect(code).toBe(2);
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
