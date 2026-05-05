/**
 * Per-dimension option counts for the sidebar filter chips
 * (specs/uplift-v2-handoff.md §2.5 / §2.7.b). Each chip in `AtsGroup` /
 * `LevelGroup` / `WorkplaceGroup` displays "{N}" so the user knows how
 * many roles a click would yield, and chips with `N === 0` render in the
 * disabled state (still visible — the spec wants the dimension's full
 * surface preserved).
 *
 * The count for a chip in dimension D is computed assuming D's selection
 * is **cleared** (so toggling the chip "from scratch" lights up its true
 * count, not the post-intersection count). All other dimensions remain
 * applied.
 */

import { type BuildFilterOptions, buildFilterCountQuery } from "./filter-sql.ts";
import type { FilterState } from "./filter-state.ts";
import { type FilterPredicate, filterRows, type SlimRow } from "./slim-index.ts";

export type CountedDimension = "ats" | "level" | "wt";

const DIMENSION_TO_COLUMN: Record<CountedDimension, string> = {
  ats: "ats",
  level: "level",
  wt: "workplace_type",
};

export interface QueryPlan {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
}

/**
 * Build a SELECT that returns `(value, count)` rows for every distinct
 * value of `dim`, applying every state predicate **except** the dim's own
 * selection. NULL values are excluded (a NULL workplace_type, for
 * instance, isn't selectable in the chip list).
 */
export function buildOptionCountsQuery(
  dim: CountedDimension,
  state: FilterState,
  options: BuildFilterOptions = {},
): QueryPlan {
  // Clear the named dimension so the count reflects "what would I get if
  // I selected only this chip in this dimension, given my other filters".
  const stateWithoutDim: FilterState = {
    ...state,
    ats: dim === "ats" ? [] : state.ats,
    level: dim === "level" ? [] : state.level,
    wt: dim === "wt" ? [] : state.wt,
  };

  // Reuse the canonical count plan to inherit every filter predicate
  // (FTS, location, since, hideRecruiter, hideStale, minComp, allowlist).
  // Then rewrite the SELECT into a GROUP BY on the dimension column.
  const countPlan = buildFilterCountQuery(stateWithoutDim, options);
  const fromIdx = countPlan.sql.indexOf("FROM ");
  const fromClause = countPlan.sql.slice(fromIdx);
  const col = DIMENSION_TO_COLUMN[dim];

  // The COUNT-based plan has no LIMIT / OFFSET, so its params are exactly
  // the WHERE-clause params. Suffix `${col} IS NOT NULL` so we drop NULLs
  // out of the chip list (chips never expose NULL).
  // Use `v` (not `value`) as the alias — `value` is reserved in some SQL
  // dialects and certain SQLite-over-JS adapters mishandle it on output.
  const sql = `SELECT ${col} AS v, COUNT(*) AS c ${fromClause} ${
    fromClause.includes("WHERE") ? "AND" : "WHERE"
  } ${col} IS NOT NULL GROUP BY ${col}`;
  return { sql, params: countPlan.params };
}

/**
 * Slim-index in-memory equivalent of `buildOptionCountsQuery`. Walks
 * `rows` once per dimension applying every predicate **except** the
 * named dimension's selection (so toggling a chip always lights up its
 * true count, not the post-intersection count).
 *
 * Uses the same predicate compiler as the FilterTable runtime via the
 * caller-supplied `buildPredicate` to keep the chip counts consistent
 * with the result count. Returns a sparse `Record<value, count>` per
 * dimension; values absent from the map count as 0 in the UI.
 */
export interface SlimOptionCounts {
  readonly ats: Record<string, number>;
  readonly level: Record<string, number>;
  readonly wt: Record<string, number>;
}

export function computeSlimOptionCounts(
  rows: ReadonlyArray<SlimRow>,
  state: FilterState,
  buildPredicate: (s: FilterState) => FilterPredicate,
): SlimOptionCounts {
  return {
    ats: countByDim(rows, state, buildPredicate, "ats"),
    level: countByDim(rows, state, buildPredicate, "level"),
    wt: countByDim(rows, state, buildPredicate, "wt"),
  };
}

function countByDim(
  rows: ReadonlyArray<SlimRow>,
  state: FilterState,
  buildPredicate: (s: FilterState) => FilterPredicate,
  dim: CountedDimension,
): Record<string, number> {
  // Clear the named dim before building the predicate.
  const cleared: FilterState = {
    ...state,
    ats: dim === "ats" ? [] : state.ats,
    level: dim === "level" ? [] : state.level,
    wt: dim === "wt" ? [] : state.wt,
  };
  const pred = buildPredicate(cleared);
  // Walk the matching set once, bucketing by the dim's column value.
  const { matches } = filterRows(rows, pred, 0, Number.POSITIVE_INFINITY);
  const out: Record<string, number> = {};
  for (const r of matches) {
    const v = dim === "ats" ? r.ats : dim === "level" ? r.level : r.workplace_type;
    if (v === null) continue;
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}
