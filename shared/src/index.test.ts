import { describe, expect, it } from "bun:test";
import { SCHEMA_VERSION } from "./index.ts";

describe("@openroles/shared", () => {
  it("exposes a semver-shaped SCHEMA_VERSION", () => {
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
