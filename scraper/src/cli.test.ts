import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, runBuildDbCommand, runHarvestCommand, runScrapeCommand } from "./cli.ts";

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
    const code = await main(["bun", "cli.ts", "report"]);
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
});
