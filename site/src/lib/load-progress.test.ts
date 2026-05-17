import { describe, expect, it } from "bun:test";
import { loadProgress } from "./load-progress.ts";

describe("loadProgress", () => {
  it("is indeterminate while loading (no counts yet)", () => {
    const p = loadProgress("loading", 0, 0, false);
    expect(p).toEqual({ visible: true, indeterminate: true, fraction: 0, label: "Loading…" });
  });

  it("is determinate during progressive load", () => {
    const p = loadProgress("loading-progressive", 4, 16, false);
    expect(p.visible).toBe(true);
    expect(p.indeterminate).toBe(false);
    expect(p.fraction).toBeCloseTo(0.25);
    expect(p.label).toBe("Loading 4 of 16…");
  });

  it("clamps fraction to [0,1] and the label count to chunksTotal", () => {
    const over = loadProgress("loading-progressive", 20, 16, false);
    expect(over.fraction).toBe(1);
    expect(over.label).toBe("Loading 16 of 16…");
    const under = loadProgress("loading-progressive", -3, 16, false);
    expect(under.fraction).toBe(0);
    expect(under.label).toBe("Loading 0 of 16…");
  });

  it("falls back to indeterminate when chunksTotal is zero/invalid", () => {
    for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = loadProgress("loading-progressive", 2, total, false);
      expect(p.indeterminate).toBe(true);
      expect(p.label).toBe("Loading…");
    }
  });

  it("treats a non-finite chunksLoaded as zero", () => {
    const p = loadProgress("loading-progressive", Number.NaN, 8, false);
    expect(p.fraction).toBe(0);
    expect(p.label).toBe("Loading 0 of 8…");
  });

  it("shows an indeterminate Filtering… bar while a query runs on ready data", () => {
    const p = loadProgress("ready", 16, 16, true);
    expect(p).toEqual({ visible: true, indeterminate: true, fraction: 0, label: "Filtering…" });
  });

  it("is hidden when ready and idle", () => {
    expect(loadProgress("ready", 16, 16, false).visible).toBe(false);
  });

  it("is hidden on error (the banner owns the error message)", () => {
    expect(loadProgress("error", 4, 16, false).visible).toBe(false);
    expect(loadProgress("error", 4, 16, true).visible).toBe(false);
  });
});
