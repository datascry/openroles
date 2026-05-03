import {
  ATS_IDS,
  type ATSId,
  LEVELS,
  type Level,
  WORKPLACE_TYPES,
  type WorkplaceType,
} from "@openroles/shared/constants";

export type SinceWindow = "24h" | "7d" | "30d" | "all";

/**
 * Phase 13: single-select sub-view that narrows results to one of the
 * user's localStorage-backed lists. See specs/filter-ui.md v1.2.0.
 */
export type ShowOnly = "saved" | "applied" | "ignored";
const SHOW_ONLY_VALUES: ReadonlyArray<ShowOnly> = ["saved", "applied", "ignored"];

export type SortOption =
  | "posted_at:desc"
  | "posted_at:asc"
  | "first_seen:desc"
  | "first_seen:asc"
  | "company:asc"
  | "company:desc"
  | "level:asc"
  | "level:desc";

const SORT_VALUES: ReadonlyArray<SortOption> = [
  "posted_at:desc",
  "posted_at:asc",
  "first_seen:desc",
  "first_seen:asc",
  "company:asc",
  "company:desc",
  "level:asc",
  "level:desc",
];

const SINCE_VALUES: ReadonlyArray<SinceWindow> = ["24h", "7d", "30d", "all"];

const Q_MAX_LEN = 256;
const MIN_COMP_CAP = 1_000_000_000;

export interface FilterState {
  readonly q: string;
  readonly ats: ReadonlyArray<ATSId>;
  readonly level: ReadonlyArray<NonNullable<Level>>;
  readonly wt: ReadonlyArray<NonNullable<WorkplaceType>>;
  readonly country: string | undefined;
  readonly region: string | undefined;
  readonly since: SinceWindow;
  readonly hideRecruiter: boolean;
  /**
   * Phase 12: when true, the query excludes rows whose `is_stale = 1`
   * (carried-forward roles whose tenant didn't scrape today). See
   * specs/role-lifecycle.md.
   */
  readonly hideStale: boolean;
  readonly minComp: number | undefined;
  readonly sort: SortOption;
  readonly page: number;
  /**
   * Single-select sub-view: when set, the result list narrows to the
   * matching localStorage slot. The id list is resolved at query time
   * (not encoded in the URL).
   */
  readonly showOnly: ShowOnly | undefined;
}

export const DEFAULT_FILTER_STATE: FilterState = {
  q: "",
  ats: [],
  level: [],
  wt: [],
  country: undefined,
  region: undefined,
  since: "all",
  hideRecruiter: false,
  hideStale: false,
  minComp: undefined,
  // posted_at:desc is the sort the index plan was designed around:
  //   - idx_jobs_posted_at      → unfiltered homepage
  //   - idx_jobs_ats_posted_at  → ATS filter
  //   - idx_jobs_level_ats / idx_jobs_workplace_type / etc serve
  //     their respective WHERE clauses with posted_at as the trailing
  //     ORDER BY (handled via secondary sort or further index lookup)
  // Switching this away forces SQLite to either (a) walk a full-table
  // sort or (b) reverse-walk a wide index that doesn't match any
  // filter, both of which translate to thousands of 1 KiB Range
  // requests over sql.js-httpvfs.
  sort: "posted_at:desc",
  page: 1,
  showOnly: undefined,
};

const NON_NULL_LEVELS = LEVELS.filter((l): l is NonNullable<Level> => l !== null);
const NON_NULL_WORKPLACES = WORKPLACE_TYPES;

export function encodeFilterState(state: FilterState): string {
  const params = new URLSearchParams();
  const cleanQ = sanitizeQuery(state.q);
  if (cleanQ) params.set("q", cleanQ);
  if (state.ats.length > 0) params.set("ats", state.ats.join(","));
  if (state.level.length > 0) params.set("level", state.level.join(","));
  if (state.wt.length > 0) params.set("wt", state.wt.join(","));
  if (state.country) params.set("country", state.country);
  if (state.region) params.set("region", state.region);
  if (state.since !== "all") params.set("since", state.since);
  if (state.hideRecruiter) params.set("recruiter", "0");
  if (state.hideStale) params.set("hide_stale", "1");
  if (state.showOnly !== undefined) params.set("show", state.showOnly);
  if (state.minComp !== undefined) params.set("min_comp", String(state.minComp));
  if (state.sort !== DEFAULT_FILTER_STATE.sort) params.set("sort", state.sort);
  if (state.page > 1) params.set("page", String(state.page));
  return params.toString();
}

function parseCsvSubset<T extends string>(
  raw: string | null,
  allowed: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (raw === null || raw === "") return [];
  const tokens = raw.split(",");
  const allowedSet = new Set<string>(allowed);
  const out: T[] = [];
  for (const t of tokens) {
    const trimmed = t.trim();
    if (allowedSet.has(trimmed) && !out.includes(trimmed as T)) out.push(trimmed as T);
  }
  return out;
}

function sanitizeQuery(raw: string): string {
  const truncated = raw.length > Q_MAX_LEN ? raw.slice(0, Q_MAX_LEN) : raw;
  if (truncated.trim().length === 0) return "";
  const words = truncated.match(/\w+/g) ?? [];
  if (words.length === 0) return "";
  if (words.every((w) => /^(?:AND|OR|NEAR)$/i.test(w))) return "";
  return truncated;
}

function parseSince(raw: string | null): SinceWindow {
  if (raw === null) return "all";
  return (SINCE_VALUES as ReadonlyArray<string>).includes(raw) ? (raw as SinceWindow) : "all";
}

function parseShowOnly(raw: string | null): ShowOnly | undefined {
  if (raw === null) return undefined;
  return (SHOW_ONLY_VALUES as ReadonlyArray<string>).includes(raw) ? (raw as ShowOnly) : undefined;
}

function parseSort(raw: string | null): SortOption {
  if (raw === null) return DEFAULT_FILTER_STATE.sort;
  return (SORT_VALUES as ReadonlyArray<string>).includes(raw)
    ? (raw as SortOption)
    : DEFAULT_FILTER_STATE.sort;
}

function parseMinComp(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(n, MIN_COMP_CAP);
}

function parsePage(raw: string | null): number {
  if (raw === null) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

function parseCountry(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const up = raw.toUpperCase();
  return /^[A-Z]{2}$/.test(up) ? up : undefined;
}

function parseRegion(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function decodeFilterState(query: string): FilterState {
  const params = new URLSearchParams(query);
  return {
    q: sanitizeQuery(params.get("q") ?? ""),
    ats: parseCsvSubset(params.get("ats"), ATS_IDS),
    level: parseCsvSubset(params.get("level"), NON_NULL_LEVELS),
    wt: parseCsvSubset(params.get("wt"), NON_NULL_WORKPLACES),
    country: parseCountry(params.get("country")),
    region: parseRegion(params.get("region")),
    since: parseSince(params.get("since")),
    hideRecruiter: params.get("recruiter") === "0",
    hideStale: params.get("hide_stale") === "1",
    showOnly: parseShowOnly(params.get("show")),
    minComp: parseMinComp(params.get("min_comp")),
    sort: parseSort(params.get("sort")),
    page: parsePage(params.get("page")),
  };
}
