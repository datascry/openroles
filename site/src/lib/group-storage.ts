import type { StorageLike } from "./storage.ts";

const NS = "openroles:filter-group";

/**
 * Per-group expansion state for the mobile filter sheet. Keyed by group id
 * (e.g. `ats`, `level`). The sidebar on desktop never collapses, so this
 * persistence is mobile-only (specs/uplift-v2-handoff.md §2.5).
 *
 * Stored as `"1"` / `"0"` strings; missing key returns `undefined` so the
 * caller can apply the default expansion policy (open by default).
 */
export function loadGroupExpansion(storage: StorageLike, groupId: string): boolean | undefined {
  const raw = storage.getItem(`${NS}:${groupId}`);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return undefined;
}

export function saveGroupExpansion(storage: StorageLike, groupId: string, expanded: boolean): void {
  storage.setItem(`${NS}:${groupId}`, expanded ? "1" : "0");
}
