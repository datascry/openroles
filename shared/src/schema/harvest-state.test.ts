import { describe, expect, it } from "bun:test";
import { HARVEST_STATE_SCHEMA_VERSION, HarvestStateSchema } from "./harvest-state.ts";

describe("HarvestStateSchema", () => {
  it("accepts a well-formed state record", () => {
    const parsed = HarvestStateSchema.parse({
      schema_version: HARVEST_STATE_SCHEMA_VERSION,
      ats: "greenhouse",
      snapshots_processed: ["2024-30", "2024-35", "2025-01"],
      tenant_count: 17234,
      last_updated_at: "2026-04-30T00:00:00Z",
    });
    expect(parsed.snapshots_processed).toHaveLength(3);
    expect(parsed.ats).toBe("greenhouse");
  });

  it("rejects a non-1.0.0 schema_version", () => {
    expect(() =>
      HarvestStateSchema.parse({
        schema_version: "1.1.0",
        ats: "greenhouse",
        snapshots_processed: [],
        tenant_count: 0,
        last_updated_at: "2026-04-30T00:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects malformed snapshot ids", () => {
    expect(() =>
      HarvestStateSchema.parse({
        schema_version: HARVEST_STATE_SCHEMA_VERSION,
        ats: "greenhouse",
        snapshots_processed: ["2024-30", "2024", "bad"],
        tenant_count: 0,
        last_updated_at: "2026-04-30T00:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects unknown ats id", () => {
    expect(() =>
      HarvestStateSchema.parse({
        schema_version: HARVEST_STATE_SCHEMA_VERSION,
        ats: "not-a-real-ats",
        snapshots_processed: [],
        tenant_count: 0,
        last_updated_at: "2026-04-30T00:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects negative tenant_count", () => {
    expect(() =>
      HarvestStateSchema.parse({
        schema_version: HARVEST_STATE_SCHEMA_VERSION,
        ats: "greenhouse",
        snapshots_processed: [],
        tenant_count: -1,
        last_updated_at: "2026-04-30T00:00:00Z",
      }),
    ).toThrow();
  });
});
