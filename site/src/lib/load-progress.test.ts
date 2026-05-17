import { describe, expect, it } from "bun:test";
import { loadProgress } from "./load-progress.ts";

describe("loadProgress", () => {
  it("is indeterminate while loading (no counts yet)", () => {
    const p = loadProgress("loading", 0, 0, false, false);
    expect(p).toEqual({ visible: true, indeterminate: true, fraction: 0, label: "Loading…" });
  });

  it("is determinate during progressive load", () => {
    const p = loadProgress("loading-progressive", 4, 16, false, false);
    expect(p.visible).toBe(true);
    expect(p.indeterminate).toBe(false);
    expect(p.fraction).toBeCloseTo(0.25);
    expect(p.label).toBe("Loading 4 of 16…");
  });

  it("STAYS visible & determinate when dbStatus is ready but chunks are still streaming", () => {
    // Regression: dbStatus flips to `ready` right after chunk 0 while
    // ~37 chunks stream in the background. The bar must not vanish.
    const p = loadProgress("ready", 5, 38, false, false);
    expect(p.visible).toBe(true);
    expect(p.indeterminate).toBe(false);
    expect(p.fraction).toBeCloseTo(5 / 38);
    expect(p.label).toBe("Loading 5 of 38…");
  });

  it("clamps fraction to [0,1] and the label count to chunksTotal", () => {
    const over = loadProgress("loading-progressive", 20, 16, false, false);
    expect(over.fraction).toBe(1);
    expect(over.label).toBe("Loading 16 of 16…");
    const under = loadProgress("loading-progressive", -3, 16, false, false);
    expect(under.fraction).toBe(0);
    expect(under.label).toBe("Loading 0 of 16…");
  });

  it("falls back to indeterminate when chunksTotal is zero/invalid", () => {
    for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = loadProgress("loading-progressive", 2, total, false, false);
      expect(p.indeterminate).toBe(true);
      expect(p.label).toBe("Loading…");
    }
  });

  it("treats a non-finite chunksLoaded as zero", () => {
    const p = loadProgress("loading-progressive", Number.NaN, 8, false, false);
    expect(p.fraction).toBe(0);
    expect(p.label).toBe("Loading 0 of 8…");
  });

  it("hides once fully loaded and idle", () => {
    expect(loadProgress("ready", 38, 38, false, true).visible).toBe(false);
    // Even if chunk counts look incomplete (a soft-failed chunk),
    // fullyLoaded is the terminal gate → hidden, never stuck.
    expect(loadProgress("ready", 36, 38, false, true).visible).toBe(false);
  });

  it("shows an indeterminate Filtering… bar only once fully loaded and a query runs", () => {
    const p = loadProgress("ready", 38, 38, true, true);
    expect(p).toEqual({ visible: true, indeterminate: true, fraction: 0, label: "Filtering…" });
  });

  it("prefers determinate chunk progress over Filtering… while still loading", () => {
    // A throttled per-chunk runFilter can flip isQueryRunning during
    // progressive load; the dominant signal is still the chunk fill.
    const p = loadProgress("ready", 10, 38, true, false);
    expect(p.indeterminate).toBe(false);
    expect(p.label).toBe("Loading 10 of 38…");
  });

  it("is hidden on error regardless of other inputs", () => {
    expect(loadProgress("error", 4, 16, false, false).visible).toBe(false);
    expect(loadProgress("error", 4, 16, true, false).visible).toBe(false);
    expect(loadProgress("error", 38, 38, true, true).visible).toBe(false);
  });
});
