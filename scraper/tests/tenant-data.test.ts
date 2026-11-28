import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TenantSchema } from "@openroles/shared";

// Data-integrity guard. build-db is NOT run in pr.yml — it only runs
// post-merge in build-deploy.yml — so a tenant row that violates
// TenantSchema (an underscore or dotted domain in a slug, a bad status,
// a malformed timestamp) sails through PR CI and only detonates at deploy
// time, freezing the live site at the last good build.
//
// This test loads every committed data/tenants/*.json and validates each
// entry against the same schema build-db uses, so bad tenant data fails
// `bun run test` at PR time. build-db still skips such rows defensively
// (see resilient-parse.ts) — this guard exists so a human fixes the source
// instead of silently shedding tenants on every refresh.
const TENANTS_DIR = join(import.meta.dir, "..", "..", "data", "tenants");

interface BadRow {
  readonly file: string;
  readonly index: number;
  readonly slug: string;
  readonly rule: string;
}

function collectBadRows(): BadRow[] {
  const bad: BadRow[] = [];
  const files = readdirSync(TENANTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw: unknown = JSON.parse(readFileSync(join(TENANTS_DIR, file), "utf8"));
    if (!Array.isArray(raw)) {
      bad.push({ file, index: -1, slug: "(root)", rule: "file is not a JSON array" });
      continue;
    }
    raw.forEach((entry, index) => {
      const parsed = TenantSchema.safeParse(entry);
      if (parsed.success) return;
      const rec = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
        string,
        unknown
      >;
      const slug = typeof rec["slug"] === "string" ? rec["slug"] : "(missing)";
      const rule = parsed.error.issues
        .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
        .join("; ");
      bad.push({ file, index, slug, rule });
    });
  }
  return bad;
}

describe("data/tenants/*.json integrity", () => {
  it("finds at least one tenant file to validate", () => {
    const files = readdirSync(TENANTS_DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
  });

  it("validates every committed tenant row against TenantSchema", () => {
    const bad = collectBadRows();
    const report = bad
      .slice(0, 50)
      .map((b) => `  ${b.file}[${b.index}] slug=${b.slug} — ${b.rule}`)
      .join("\n");
    const more = bad.length > 50 ? `\n  …and ${bad.length - 50} more` : "";
    expect(
      bad.length,
      bad.length === 0
        ? ""
        : `${bad.length} invalid tenant row(s) in data/tenants/. Fix or remove them — build-db would drop these at deploy time:\n${report}${more}`,
    ).toBe(0);
  });
});
