import { DEFAULT_FILTER_STATE, type FilterState } from "./filter-state.ts";

/**
 * Logical filter groups in the sidebar / sheet. The orchestrator iterates
 * this list to render group sections and to drive the per-group active-count
 * indicator (specs/uplift-v2-handoff.md §2.5).
 *
 * `search` is included so the total covers the search field too — even though
 * it does not render inside the sidebar (the search bar is its own surface).
 */
export type FilterGroup =
  | "search"
  | "ats"
  | "level"
  | "wt"
  | "posted"
  | "minComp"
  | "status"
  | "personal";

export const FILTER_GROUPS: ReadonlyArray<FilterGroup> = [
  "search",
  "ats",
  "level",
  "wt",
  "posted",
  "minComp",
  "status",
  "personal",
];

/**
 * Per-group active count. Multi-select groups return their selection length;
 * single-select / boolean groups return 0 or 1; `status` aggregates the two
 * boolean toggles into a sum 0–2.
 *
 * `minComp = 0` is treated as undefined for counting (spec §2.7.d — clearing
 * the filter is the user's intent when they zero the stepper).
 */
export function activeCountFor(group: FilterGroup, state: FilterState): number {
  switch (group) {
    case "search":
      return state.q ? 1 : 0;
    case "ats":
      return state.ats.length;
    case "level":
      return state.level.length;
    case "wt":
      return state.wt.length;
    case "posted":
      // Compare against the runtime default (currently "30d") rather than
      // "all". The default-narrow window ships everywhere; counting it as
      // "active" would surface a stale "1 active" indicator on every fresh
      // visit, which is misleading. Active = user has changed it.
      return state.since !== DEFAULT_FILTER_STATE.since ? 1 : 0;
    case "minComp":
      return state.minComp !== undefined && state.minComp > 0 ? 1 : 0;
    case "status":
      return (state.hideRecruiter ? 1 : 0) + (state.hideStale ? 1 : 0);
    case "personal":
      return state.showOnly !== undefined ? 1 : 0;
  }
}

/**
 * Total active filter count across every group. Equivalent to summing
 * `activeCountFor` across `FILTER_GROUPS` — kept as its own function so
 * call-sites do not need to import `FILTER_GROUPS` to derive the total.
 */
export function totalActiveCount(state: FilterState): number {
  let total = 0;
  for (const group of FILTER_GROUPS) {
    total += activeCountFor(group, state);
  }
  return total;
}
