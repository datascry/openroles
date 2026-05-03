import { beforeEach, describe, expect, it } from "bun:test";
import {
  loadApplied,
  loadIgnored,
  loadSaved,
  markApplied,
  STORAGE_KEYS,
  type StorageLike,
  toggleIgnored,
  toggleSaved,
  unmarkApplied,
} from "./storage.ts";

class MemoryStorage implements StorageLike {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  raw(key: string): string | undefined {
    return this.store.get(key);
  }
}

// Phase 14: storage migrated from 64-char full Job.id to 16-char short_id.
// HEX_A_LONG / HEX_B_LONG simulate legacy entries that get normalised to
// their 16-char prefix on load. HEX_A / HEX_B are the canonical form.
const HEX_A = "a".repeat(16);
const HEX_B = "b".repeat(16);
const HEX_A_LONG = "a".repeat(64);
const HEX_B_LONG = "b".repeat(64);
const ISO = "2026-04-26T00:00:00Z";

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
});

describe("loadSaved / toggleSaved", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(loadSaved(storage)).toEqual({ version: 1, ids: [] });
  });

  it("toggleSaved adds, then removes, on second call", () => {
    expect(toggleSaved(storage, HEX_A)).toBe(true);
    expect(loadSaved(storage).ids).toEqual([HEX_A]);
    expect(toggleSaved(storage, HEX_A)).toBe(false);
    expect(loadSaved(storage).ids).toEqual([]);
  });

  it("rejects non-hex ids", () => {
    expect(toggleSaved(storage, "not-an-id")).toBe(false);
    expect(loadSaved(storage).ids).toEqual([]);
  });

  it("ignores corrupted JSON", () => {
    storage.setItem(STORAGE_KEYS.saved, "{not json");
    expect(loadSaved(storage)).toEqual({ version: 1, ids: [] });
  });

  it("ignores wrong version", () => {
    storage.setItem(STORAGE_KEYS.saved, JSON.stringify({ version: 2, ids: [HEX_A] }));
    expect(loadSaved(storage)).toEqual({ version: 1, ids: [] });
  });

  it("filters out non-hex entries from existing storage", () => {
    storage.setItem(STORAGE_KEYS.saved, JSON.stringify({ version: 1, ids: [HEX_A, "garbage"] }));
    expect(loadSaved(storage).ids).toEqual([HEX_A]);
  });

  it("normalises legacy 64-char ids to 16-char on load", () => {
    storage.setItem(
      STORAGE_KEYS.saved,
      JSON.stringify({ version: 1, ids: [HEX_A_LONG, HEX_B_LONG] }),
    );
    expect(loadSaved(storage).ids).toEqual([HEX_A, HEX_B]);
  });

  it("toggleSaved with a 64-char id matches a 16-char saved entry (migration)", () => {
    toggleSaved(storage, HEX_A);
    expect(toggleSaved(storage, HEX_A_LONG)).toBe(false);
    expect(loadSaved(storage).ids).toEqual([]);
  });
});

describe("markApplied / unmarkApplied / loadApplied", () => {
  it("records id + ISO applied_at", () => {
    expect(markApplied(storage, HEX_A, ISO)).toBe(true);
    const applied = loadApplied(storage);
    expect(applied.entries).toHaveLength(1);
    expect(applied.entries[0]?.id).toBe(HEX_A);
  });

  it("does not double-record the same id", () => {
    markApplied(storage, HEX_A, ISO);
    expect(markApplied(storage, HEX_A, ISO)).toBe(false);
    expect(loadApplied(storage).entries).toHaveLength(1);
  });

  it("unmarkApplied removes the entry", () => {
    markApplied(storage, HEX_A, ISO);
    expect(unmarkApplied(storage, HEX_A)).toBe(true);
    expect(loadApplied(storage).entries).toEqual([]);
  });

  it("unmarkApplied returns false when the id was not applied", () => {
    expect(unmarkApplied(storage, HEX_A)).toBe(false);
  });

  it("rejects non-hex id and malformed ISO", () => {
    expect(markApplied(storage, "not-hex", ISO)).toBe(false);
    expect(markApplied(storage, HEX_A, "yesterday")).toBe(false);
  });

  it("filters out malformed entries from existing storage", () => {
    storage.setItem(
      STORAGE_KEYS.applied,
      JSON.stringify({
        version: 1,
        entries: [
          { id: HEX_A, applied_at: ISO },
          { id: "bogus", applied_at: ISO },
          { id: HEX_B, applied_at: "yesterday" },
        ],
      }),
    );
    expect(loadApplied(storage).entries.map((e) => e.id)).toEqual([HEX_A]);
  });

  it("rejects non-array entries field", () => {
    storage.setItem(STORAGE_KEYS.applied, JSON.stringify({ version: 1, entries: "not an array" }));
    expect(loadApplied(storage).entries).toEqual([]);
  });
});

describe("loadIgnored / toggleIgnored", () => {
  it("toggleIgnored adds, then removes", () => {
    expect(toggleIgnored(storage, HEX_A)).toBe(true);
    expect(loadIgnored(storage).ids).toEqual([HEX_A]);
    expect(toggleIgnored(storage, HEX_A)).toBe(false);
    expect(loadIgnored(storage).ids).toEqual([]);
  });

  it("rejects non-hex ids", () => {
    expect(toggleIgnored(storage, "x")).toBe(false);
  });
});
