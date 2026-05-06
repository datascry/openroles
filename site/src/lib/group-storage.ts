import type { StorageLike } from "./storage.ts";

const NS = "openroles:filter-group";

/**
 * Per-group expansion state for the filter sidebar (desktop) and sheet
 * (mobile). Keyed by group id (e.g. `ats`, `level`).
 *
 * Stored as `"1"` / `"0"` strings; missing key returns `undefined` so the
 * caller can apply the default expansion policy (ATS + Level open, the
 * rest collapsed) on first visit.
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
