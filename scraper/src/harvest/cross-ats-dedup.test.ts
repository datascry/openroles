import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tenant } from "@openroles/shared";
import { collectLiveSlugsExcluding, liveSlugsExcluding } from "./cross-ats-dedup.ts";

function t(ats: string, slug: string, status: string): Tenant {
  return {
    ats,
    slug,
    status,
    last_probed_at: "2026-01-01T00:00:00Z",
  } as Tenant;
}

describe("collectLiveSlugsExcluding", () => {
  it("collects live slugs from every ATS except the excluded one", () => {
    const out = collectLiveSlugsExcluding(
      [
        [t("workday", "acme", "live"), t("workday", "beta", "dead")],
        [t("eightfold", "gamma", "live")],
        [t("gjobsfeed", "acme", "transient_failure"), t("gjobsfeed", "delta", "live")],
      ],
      "gjobsfeed",
    );
    // acme (workday live) + gamma (eightfold live). beta is dead;
    // delta is gjobsfeed (excluded); the gjobsfeed acme row is excluded.
    expect([...out].sort()).toEqual(["acme", "gamma"]);
  });

  it("returns an empty set when nothing is live elsewhere", () => {
    expect(
      collectLiveSlugsExcluding(
        [[t("gjobsfeed", "x", "live")], [t("workday", "y", "dead")]],
        "gjobsfeed",
      ).size,
    ).toBe(0);
  });

  it("dedupes a slug live under multiple other ATSes to one entry", () => {
    const out = collectLiveSlugsExcluding(
      [[t("workday", "z", "live")], [t("icims", "z", "live")]],
      "gjobsfeed",
    );
    expect([...out]).toEqual(["z"]);
  });
});

describe("liveSlugsExcluding (fs)", () => {
  it("reads tenant files and skips unreadable / malformed / non-array files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xats-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "workday.json"),
      JSON.stringify([t("workday", "acme", "live"), t("workday", "old", "dead")]),
    );
    writeFileSync(join(dir, "eightfold.json"), JSON.stringify([t("eightfold", "beta", "live")]));
    writeFileSync(join(dir, "gjobsfeed.json"), JSON.stringify([t("gjobsfeed", "acme", "live")]));
    writeFileSync(join(dir, "broken.json"), "{ not valid json");
    writeFileSync(join(dir, "object.json"), JSON.stringify({ not: "an array" }));
    writeFileSync(join(dir, "ignore.txt"), "not json at all");

    const out = await liveSlugsExcluding(dir, "gjobsfeed");
    expect([...out].sort()).toEqual(["acme", "beta"]);
  });

  it("returns an empty set when the directory does not exist", async () => {
    const out = await liveSlugsExcluding(join(tmpdir(), "definitely-not-here-xyz"), "gjobsfeed");
    expect(out.size).toBe(0);
  });
});
