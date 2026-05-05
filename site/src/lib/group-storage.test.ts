import { beforeEach, describe, expect, it } from "bun:test";
import { loadGroupExpansion, saveGroupExpansion } from "./group-storage.ts";
import type { StorageLike } from "./storage.ts";

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
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
});

describe("group-storage", () => {
  it("returns undefined when no entry has been written", () => {
    expect(loadGroupExpansion(storage, "ats")).toBeUndefined();
  });

  it("round-trips an expanded value", () => {
    saveGroupExpansion(storage, "ats", true);
    expect(loadGroupExpansion(storage, "ats")).toBe(true);
  });

  it("round-trips a collapsed value", () => {
    saveGroupExpansion(storage, "level", false);
    expect(loadGroupExpansion(storage, "level")).toBe(false);
  });

  it("namespaces by group id so groups don't collide", () => {
    saveGroupExpansion(storage, "ats", true);
    saveGroupExpansion(storage, "level", false);
    expect(loadGroupExpansion(storage, "ats")).toBe(true);
    expect(loadGroupExpansion(storage, "level")).toBe(false);
  });

  it("returns undefined for any value that is not '1' or '0'", () => {
    storage.setItem("openroles:filter-group:ats", "garbage");
    expect(loadGroupExpansion(storage, "ats")).toBeUndefined();
  });
});
