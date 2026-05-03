<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: ATS_IDS / WORKPLACE_TYPES are used in the Svelte template (each block) below

import type { Job } from "@openroles/shared";
import { ATS_IDS, LEVELS, WORKPLACE_TYPES } from "@openroles/shared/constants";
import { onMount } from "svelte";
import { sanitizeChipLabel } from "../lib/chip-label.ts";
import { type ClientDb, loadClientDb } from "../lib/client-db.ts";
import { buildFilterCountQuery, buildFilterQuery } from "../lib/filter-sql.ts";
import {
  DEFAULT_FILTER_STATE,
  decodeFilterState,
  encodeFilterState,
  type FilterState,
  type SinceWindow,
  type SortOption,
} from "../lib/filter-state.ts";
import { pagesToShow } from "../lib/pager.ts";
import {
  loadApplied,
  loadIgnored,
  loadSaved,
  markApplied,
  toggleIgnored,
  toggleSaved,
} from "../lib/storage.ts";

interface Props {
  basePath?: string;
}

const { basePath = "" }: Props = $props();

const NON_NULL_LEVELS = LEVELS.filter((l): l is NonNullable<(typeof LEVELS)[number]> => l !== null);

const SINCE_OPTIONS: ReadonlyArray<{ value: SinceWindow; label: string }> = [
  { value: "all", label: "Any time" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

const SINCE_LABEL: Record<SinceWindow, string> = {
  all: "ANY TIME",
  "24h": "LAST 24H",
  "7d": "LAST 7 DAYS",
  "30d": "LAST 30 DAYS",
};

const SORT_OPTIONS: ReadonlyArray<{ value: SortOption; label: string }> = [
  { value: "posted_at:desc", label: "Newest first" },
  { value: "posted_at:asc", label: "Oldest first" },
  { value: "first_seen:desc", label: "First seen (newest)" },
  { value: "first_seen:asc", label: "First seen (oldest)" },
  { value: "company:asc", label: "Company A→Z" },
  { value: "company:desc", label: "Company Z→A" },
  { value: "level:asc", label: "Level: junior → senior" },
  { value: "level:desc", label: "Level: senior → junior" },
];

const SORT_SHORT: Record<SortOption, string> = {
  "posted_at:desc": "NEWEST FIRST",
  "posted_at:asc": "OLDEST FIRST",
  "first_seen:desc": "FIRST SEEN ↓",
  "first_seen:asc": "FIRST SEEN ↑",
  "company:asc": "COMPANY A→Z",
  "company:desc": "COMPANY Z→A",
  "level:asc": "LEVEL ↑",
  "level:desc": "LEVEL ↓",
};

const PAGE_SIZE = 50;
const Q_DEBOUNCE_MS = 250;
const QUERY_DEBOUNCE_MS = 50;

type JobRow = Pick<
  Job,
  | "id"
  | "ats"
  | "tenant_slug"
  | "title"
  | "company"
  | "location_text"
  | "level"
  | "workplace_type"
  | "posted_at"
  | "last_seen_at"
  | "url"
> & {
  is_recruiter_post: 0 | 1;
  /** SQLite stores is_stale as INTEGER 0/1 — see specs/role-lifecycle.md. */
  is_stale: 0 | 1;
};

type DbStatus = "loading" | "ready" | "error";

type FilterCategory = "ats" | "level" | "wt" | "since" | "min_comp" | "sort";

let state: FilterState = $state(
  typeof window === "undefined"
    ? DEFAULT_FILTER_STATE
    : decodeFilterState(window.location.search.replace(/^\?/, "")),
);

let qInput = $state(state.q);
let qDebounceHandle: ReturnType<typeof setTimeout> | undefined;

let clientDb: ClientDb | null = $state(null);
let dbStatus: DbStatus = $state("loading");
let dbError: string | null = $state(null);
let queryError: string | null = $state(null);
let rows: JobRow[] = $state([]);
let totalCount: number = $state(0);
let queryToken: number = 0;
let queryDebounceHandle: ReturnType<typeof setTimeout> | undefined;

let savedIds: ReadonlyArray<string> = $state([]);
let appliedIds: ReadonlyArray<string> = $state([]);
let ignoredIds: ReadonlyArray<string> = $state([]);
let hideIgnored = $state(true);

// Single open category at a time. Click outside or a different "+ Add"
// button closes any open popover. Esc also closes.
let openCategory: FilterCategory | null = $state(null);

let filterBarEl: HTMLElement | null = $state(null);

function refreshUserLists(): void {
  if (typeof window === "undefined") return;
  savedIds = loadSaved(window.localStorage).ids;
  appliedIds = loadApplied(window.localStorage).entries.map((e) => e.id);
  ignoredIds = loadIgnored(window.localStorage).ids;
}

function isSaved(id: string): boolean {
  return savedIds.includes(id);
}

function isApplied(id: string): boolean {
  return appliedIds.includes(id);
}

function isIgnored(id: string): boolean {
  return ignoredIds.includes(id);
}

function onToggleSaved(id: string): void {
  if (typeof window === "undefined") return;
  toggleSaved(window.localStorage, id);
  refreshUserLists();
}

function onToggleIgnored(id: string): void {
  if (typeof window === "undefined") return;
  toggleIgnored(window.localStorage, id);
  refreshUserLists();
}

function onMarkApplied(id: string): void {
  if (typeof window === "undefined") return;
  markApplied(window.localStorage, id, new Date().toISOString());
  refreshUserLists();
}

// `Hide ignored` is the post-query filter that strips ignored rows from
// view by default. When the user has explicitly opted into the ignored
// sub-view (`showOnly === "ignored"`), short-circuit the post-filter so
// the panel actually has rows to show. Same precedence rule as the spec.
const visibleRows = $derived(
  state.showOnly === "ignored" ? rows : hideIgnored ? rows.filter((r) => !isIgnored(r.id)) : rows,
);

function syncUrl(next: FilterState) {
  if (typeof window === "undefined") return;
  const qs = encodeFilterState(next);
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

function updateState(patch: Partial<FilterState>) {
  state = { ...state, ...patch, page: patch.page ?? 1 };
  syncUrl(state);
}

function onQInput(value: string) {
  qInput = value;
  if (qDebounceHandle) clearTimeout(qDebounceHandle);
  qDebounceHandle = setTimeout(() => updateState({ q: value }), Q_DEBOUNCE_MS);
}

function clearQ() {
  qInput = "";
  if (qDebounceHandle) clearTimeout(qDebounceHandle);
  updateState({ q: "" });
}

function toggleAts(id: (typeof ATS_IDS)[number]) {
  const next = state.ats.includes(id) ? state.ats.filter((x) => x !== id) : [...state.ats, id];
  updateState({ ats: next });
}

function removeAts(id: (typeof ATS_IDS)[number]) {
  updateState({ ats: state.ats.filter((x) => x !== id) });
}

function toggleLevel(id: NonNullable<(typeof LEVELS)[number]>) {
  const next = state.level.includes(id)
    ? state.level.filter((x) => x !== id)
    : [...state.level, id];
  updateState({ level: next });
}

function removeLevel(id: NonNullable<(typeof LEVELS)[number]>) {
  updateState({ level: state.level.filter((x) => x !== id) });
}

function toggleWt(id: (typeof WORKPLACE_TYPES)[number]) {
  const next = state.wt.includes(id) ? state.wt.filter((x) => x !== id) : [...state.wt, id];
  updateState({ wt: next });
}

function removeWt(id: (typeof WORKPLACE_TYPES)[number]) {
  updateState({ wt: state.wt.filter((x) => x !== id) });
}

function setSort(value: SortOption) {
  updateState({ sort: value });
}

function setSince(value: SinceWindow) {
  updateState({ since: value });
}

function setMinComp(raw: string) {
  if (raw.trim() === "") {
    updateState({ minComp: undefined });
    return;
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) updateState({ minComp: n });
}

function gotoPage(page: number) {
  if (page < 1) return;
  state = { ...state, page };
  syncUrl(state);
}

function resetAll() {
  state = { ...DEFAULT_FILTER_STATE };
  qInput = "";
  syncUrl(state);
}

function togglePopover(cat: FilterCategory) {
  openCategory = openCategory === cat ? null : cat;
}

function closePopover() {
  openCategory = null;
}

const totalPages = $derived(Math.max(1, Math.ceil(totalCount / PAGE_SIZE)));
const hasPrev = $derived(state.page > 1);
const hasNext = $derived(state.page < totalPages);

const activeFilterCount = $derived(
  (state.q ? 1 : 0) +
    state.ats.length +
    state.level.length +
    state.wt.length +
    (state.since !== "all" ? 1 : 0) +
    (state.hideRecruiter ? 1 : 0) +
    (state.hideStale ? 1 : 0) +
    (state.showOnly !== undefined ? 1 : 0) +
    (state.minComp !== undefined ? 1 : 0),
);

const pagerPages = $derived(totalPages > 1 ? pagesToShow(state.page, totalPages) : []);

const sanitizedQ = $derived(sanitizeChipLabel(state.q));

onMount(async () => {
  refreshUserLists();
  try {
    clientDb = await loadClientDb({ basePath });
    dbStatus = "ready";
  } catch (err) {
    dbStatus = "error";
    dbError = err instanceof Error ? err.message : String(err);
  }
});

function hasAnyFilter(s: FilterState): boolean {
  return (
    s.q.trim().length > 0 ||
    s.ats.length > 0 ||
    s.level.length > 0 ||
    s.wt.length > 0 ||
    s.since !== "all" ||
    s.hideRecruiter ||
    s.hideStale ||
    s.showOnly !== undefined ||
    s.minComp !== undefined ||
    s.country !== undefined ||
    s.region !== undefined
  );
}

async function runQuery(currentState: FilterState, db: ClientDb): Promise<void> {
  const token = ++queryToken;
  // Phase 13: when showOnly is set, narrow results to the matching
  // localStorage list. Empty list intentionally yields zero rows
  // (specs/filter-ui.md v1.2.0 §Saved / applied / ignored sub-views).
  const idAllowlist =
    currentState.showOnly === "saved"
      ? savedIds
      : currentState.showOnly === "applied"
        ? appliedIds
        : currentState.showOnly === "ignored"
          ? ignoredIds
          : undefined;
  const opts = idAllowlist !== undefined ? { idAllowlist } : {};
  const plan = buildFilterQuery(currentState, opts);
  // Optimization: when no filters are active, the count is the manifest's
  // total_rows — skip the COUNT(*) query entirely. SQLite's COUNT(*) walks
  // the smallest index, which is still ~the whole index over HTTP — that
  // alone transfers >100MB to render the homepage. With filters active
  // the WHERE clause prunes most pages, so the count remains fast.
  const skipCount = !hasAnyFilter(currentState);
  const countPlan = buildFilterCountQuery(currentState, opts);
  try {
    if (skipCount) {
      const resultRows = await db.query<JobRow>(plan.sql, plan.params);
      if (token !== queryToken) return;
      rows = resultRows;
      totalCount = db.manifest.total_rows;
      queryError = null;
      return;
    }
    const [resultRows, countRows] = await Promise.all([
      db.query<JobRow>(plan.sql, plan.params),
      db.query<{ c: number }>(countPlan.sql, countPlan.params),
    ]);
    if (token !== queryToken) return;
    rows = resultRows;
    totalCount = countRows[0]?.c ?? 0;
    queryError = null;
  } catch (err) {
    if (token !== queryToken) return;
    queryError = err instanceof Error ? err.message : String(err);
    // biome-ignore lint/suspicious/noConsole: dev-only diagnostic for query failures
    if (import.meta.env.DEV && typeof console !== "undefined" && console.error) {
      console.error("filter-table:query-failed", err);
    }
  }
}

$effect(() => {
  const snapshot = state;
  const db = clientDb;
  if (!db || dbStatus !== "ready") return;
  if (queryDebounceHandle) clearTimeout(queryDebounceHandle);
  queryDebounceHandle = setTimeout(() => {
    void runQuery(snapshot, db);
  }, QUERY_DEBOUNCE_MS);
});

// Click-outside + Esc close the open popover.
$effect(() => {
  if (openCategory === null) return;
  if (typeof document === "undefined") return;

  function onClickOutside(e: MouseEvent) {
    const target = e.target as Node | null;
    if (target && filterBarEl && !filterBarEl.contains(target)) {
      closePopover();
    }
  }
  function onEsc(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePopover();
    }
  }
  document.addEventListener("mousedown", onClickOutside);
  document.addEventListener("keydown", onEsc);
  return () => {
    document.removeEventListener("mousedown", onClickOutside);
    document.removeEventListener("keydown", onEsc);
  };
});

function formatAge(
  iso: string | null | undefined,
  now: number = Date.now(),
): {
  label: string;
  fresh: boolean;
} {
  if (!iso) return { label: "—", fresh: false };
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { label: "—", fresh: false };
  const diff = Math.max(0, now - t);
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return { label: `${hours}h`, fresh: true };
  const days = Math.floor(hours / 24);
  if (days < 30) return { label: `${days}d`, fresh: false };
  return { label: new Date(iso).toISOString().slice(0, 10), fresh: false };
}

/**
 * Days since the role was last scraped successfully — used to render the
 * `STALE · ND` badge per specs/role-lifecycle.md. Floors at 1 day so a
 * row marked stale on the same calendar day as build still reads "1d"
 * rather than "0d".
 */
function staleAgeDays(lastSeenAt: string | undefined, now: number = Date.now()): number {
  if (!lastSeenAt) return 1;
  const t = new Date(lastSeenAt).getTime();
  if (Number.isNaN(t)) return 1;
  return Math.max(1, Math.floor((now - t) / 86_400_000));
}

function clickSort(col: "posted_at" | "company" | "level" | "first_seen") {
  const cur = state.sort;
  if (col === "posted_at") {
    setSort(cur === "posted_at:desc" ? "posted_at:asc" : "posted_at:desc");
  } else if (col === "company") {
    setSort(cur === "company:asc" ? "company:desc" : "company:asc");
  } else if (col === "level") {
    setSort(cur === "level:asc" ? "level:desc" : "level:asc");
  } else if (col === "first_seen") {
    setSort(cur === "first_seen:desc" ? "first_seen:asc" : "first_seen:desc");
  }
}

function ariaSort(
  col: "posted_at" | "company" | "level" | "first_seen",
): "ascending" | "descending" | "none" {
  const s = state.sort;
  if (col === "posted_at") {
    if (s === "posted_at:asc") return "ascending";
    if (s === "posted_at:desc") return "descending";
  }
  if (col === "company") {
    if (s === "company:asc") return "ascending";
    if (s === "company:desc") return "descending";
  }
  if (col === "level") {
    if (s === "level:asc") return "ascending";
    if (s === "level:desc") return "descending";
  }
  if (col === "first_seen") {
    if (s === "first_seen:asc") return "ascending";
    if (s === "first_seen:desc") return "descending";
  }
  return "none";
}
</script>

<!-- Sticky search input. The primary affordance for filtering. The
     `field:value` syntax is documented in specs/filter-ui.md v1.2.0;
     the placeholder hints at it without overwhelming new users, and
     the <details> below the input expands with a full reference. -->
<div class="search-row">
  <label class="search-label">
    <span class="visually-hidden">Search roles</span>
    <input
      type="search"
      placeholder='Search roles — try title:engineer or company:stripe location:remote'
      maxlength="256"
      value={qInput}
      oninput={(e) => onQInput((e.currentTarget as HTMLInputElement).value)}
    />
  </label>
  <details class="search-help">
    <summary>Search syntax</summary>
    <ul role="list">
      <li><code>title:engineer</code> — match the title only</li>
      <li><code>company:stripe</code> — match the company only</li>
      <li><code>description:remote</code> — match the description excerpt</li>
      <li><code>location:"san francisco"</code> — substring match on the location text</li>
      <li><code>"senior engineer"</code> — match the literal phrase across all fields</li>
      <li><code>title:senior company:stripe</code> — combine, AND-joined</li>
    </ul>
  </details>
</div>

<!-- Filter bar: applied filters + add-filter buttons + sort + reset.
     The strip wraps; on desktop it stays on a single row when possible. -->
<div class="filter-bar" bind:this={filterBarEl}>
  <!-- Applied filters render first so the user sees what's already on. -->
  {#if state.q && sanitizedQ}
    <button type="button" class="active-chip accent" onclick={clearQ}>
      <span aria-hidden="true">"{sanitizedQ}"</span>
      <span class="visually-hidden">remove search filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}
  {#each state.ats as id (`ats-${id}`)}
    <button type="button" class="active-chip" onclick={() => removeAts(id)}>
      <span>{id}</span>
      <span class="visually-hidden">remove ATS filter {id}</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/each}
  {#each state.level as id (`level-${id}`)}
    <button type="button" class="active-chip" onclick={() => removeLevel(id)}>
      <span>{id}</span>
      <span class="visually-hidden">remove level filter {id}</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/each}
  {#each state.wt as id (`wt-${id}`)}
    <button type="button" class="active-chip" onclick={() => removeWt(id)}>
      <span>{id}</span>
      <span class="visually-hidden">remove workplace filter {id}</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/each}
  {#if state.since !== "all"}
    <button type="button" class="active-chip" onclick={() => setSince("all")}>
      <span>{SINCE_LABEL[state.since]}</span>
      <span class="visually-hidden">remove posted-within filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}
  {#if state.hideRecruiter}
    <button type="button" class="active-chip" onclick={() => updateState({ hideRecruiter: false })}>
      <span>NO RECRUITERS</span>
      <span class="visually-hidden">remove recruiter filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}
  {#if state.hideStale}
    <button type="button" class="active-chip" onclick={() => updateState({ hideStale: false })}>
      <span>VERIFIED ONLY</span>
      <span class="visually-hidden">remove verified-only filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}
  {#if state.showOnly !== undefined}
    <button
      type="button"
      class="active-chip accent"
      onclick={() => updateState({ showOnly: undefined })}
    >
      <span>SHOWING {state.showOnly.toUpperCase()}</span>
      <span class="visually-hidden">remove sub-view filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}
  {#if state.minComp !== undefined}
    <button type="button" class="active-chip" onclick={() => updateState({ minComp: undefined })}>
      <span>MIN ${Math.floor(state.minComp / 1000)}K</span>
      <span class="visually-hidden">remove min comp filter</span>
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/if}

  <!-- Add-filter buttons. Each opens an inline popover anchored below. -->
  <div class="popover-anchor">
    <button
      type="button"
      class="add-button"
      aria-haspopup="true"
      aria-expanded={openCategory === "ats"}
      onclick={() => togglePopover("ats")}
    >+ ATS</button>
    {#if openCategory === "ats"}
      <div class="popover" role="dialog" aria-label="Filter by ATS">
        <div class="chip-grid">
          {#each ATS_IDS as id (id)}
            <label class="chip">
              <input
                type="checkbox"
                checked={state.ats.includes(id)}
                onchange={() => toggleAts(id)}
              />
              <span>{id}</span>
            </label>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="popover-anchor">
    <button
      type="button"
      class="add-button"
      aria-haspopup="true"
      aria-expanded={openCategory === "level"}
      onclick={() => togglePopover("level")}
    >+ Level</button>
    {#if openCategory === "level"}
      <div class="popover" role="dialog" aria-label="Filter by level">
        <div class="chip-grid">
          {#each NON_NULL_LEVELS as id (id)}
            <label class="chip">
              <input
                type="checkbox"
                checked={state.level.includes(id)}
                onchange={() => toggleLevel(id)}
              />
              <span>{id}</span>
            </label>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="popover-anchor">
    <button
      type="button"
      class="add-button"
      aria-haspopup="true"
      aria-expanded={openCategory === "wt"}
      onclick={() => togglePopover("wt")}
    >+ Workplace</button>
    {#if openCategory === "wt"}
      <div class="popover" role="dialog" aria-label="Filter by workplace">
        <div class="chip-grid">
          {#each WORKPLACE_TYPES as id (id)}
            <label class="chip">
              <input
                type="checkbox"
                checked={state.wt.includes(id)}
                onchange={() => toggleWt(id)}
              />
              <span>{id}</span>
            </label>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="popover-anchor">
    <button
      type="button"
      class="add-button"
      aria-haspopup="true"
      aria-expanded={openCategory === "since"}
      onclick={() => togglePopover("since")}
    >+ Posted</button>
    {#if openCategory === "since"}
      <div class="popover popover--narrow" role="dialog" aria-label="Posted within">
        <ul role="list" class="radio-list">
          {#each SINCE_OPTIONS as opt (opt.value)}
            <li>
              <label class="radio">
                <input
                  type="radio"
                  name="since"
                  value={opt.value}
                  checked={state.since === opt.value}
                  onchange={() => { setSince(opt.value); closePopover(); }}
                />
                <span>{opt.label}</span>
              </label>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>

  <div class="popover-anchor">
    <button
      type="button"
      class="add-button"
      aria-haspopup="true"
      aria-expanded={openCategory === "min_comp"}
      onclick={() => togglePopover("min_comp")}
    >+ Min comp</button>
    {#if openCategory === "min_comp"}
      <div class="popover popover--narrow" role="dialog" aria-label="Minimum compensation">
        <label class="number-label">
          <span>Minimum (USD)</span>
          <input
            type="number"
            min="0"
            step="1000"
            inputmode="numeric"
            placeholder="—"
            value={state.minComp ?? ""}
            onchange={(e) => setMinComp((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
      </div>
    {/if}
  </div>

  <button
    type="button"
    class="add-button"
    aria-pressed={state.hideRecruiter}
    onclick={() => updateState({ hideRecruiter: !state.hideRecruiter })}
  >{state.hideRecruiter ? "✓ No recruiters" : "+ No recruiters"}</button>

  <!-- Phase 12: a quick toggle to hide carried-forward stale rows when the
       user only wants verified-today roles. See specs/role-lifecycle.md. -->
  <button
    type="button"
    class="add-button"
    aria-pressed={state.hideStale}
    onclick={() => updateState({ hideStale: !state.hideStale })}
  >{state.hideStale ? "✓ Verified only" : "+ Verified only"}</button>

  <!-- Phase 13: single-select sub-view toggles. Activating one clears any
       other sub-view selection (mutually exclusive per spec). -->
  <button
    type="button"
    class="add-button"
    aria-pressed={state.showOnly === "saved"}
    onclick={() => updateState({ showOnly: state.showOnly === "saved" ? undefined : "saved" })}
  >{state.showOnly === "saved" ? "✓ Saved" : "+ Saved"}{savedIds.length > 0 ? ` · ${savedIds.length}` : ""}</button>
  <button
    type="button"
    class="add-button"
    aria-pressed={state.showOnly === "applied"}
    onclick={() => updateState({ showOnly: state.showOnly === "applied" ? undefined : "applied" })}
  >{state.showOnly === "applied" ? "✓ Applied" : "+ Applied"}{appliedIds.length > 0 ? ` · ${appliedIds.length}` : ""}</button>
  <button
    type="button"
    class="add-button"
    aria-pressed={state.showOnly === "ignored"}
    onclick={() => updateState({ showOnly: state.showOnly === "ignored" ? undefined : "ignored" })}
  >{state.showOnly === "ignored" ? "✓ Ignored" : "+ Ignored"}{ignoredIds.length > 0 ? ` · ${ignoredIds.length}` : ""}</button>

  <div class="popover-anchor sort-anchor">
    <button
      type="button"
      class="add-button"
      aria-haspopup="true"
      aria-expanded={openCategory === "sort"}
      onclick={() => togglePopover("sort")}
    >Sort: {SORT_SHORT[state.sort]}</button>
    {#if openCategory === "sort"}
      <div class="popover popover--narrow popover--right" role="dialog" aria-label="Sort">
        <ul role="list" class="radio-list">
          {#each SORT_OPTIONS as opt (opt.value)}
            <li>
              <label class="radio">
                <input
                  type="radio"
                  name="sort"
                  value={opt.value}
                  checked={state.sort === opt.value}
                  onchange={() => { setSort(opt.value); closePopover(); }}
                />
                <span>{opt.label}</span>
              </label>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>

  {#if activeFilterCount > 0}
    <button type="button" class="reset" onclick={resetAll}>Reset all</button>
  {/if}
</div>

<p class="results-status" aria-live="polite" aria-busy={dbStatus === "loading"}>
  {#if dbStatus === "ready"}
    {#if state.showOnly !== undefined}<span class="status-scope">{state.showOnly.toUpperCase()} ·</span> {/if}
    <b>{totalCount.toLocaleString()}</b> {totalCount === 1 ? "ROLE" : "ROLES"} ·
    PAGE {state.page}
  {:else if dbStatus === "loading"}
    LOADING…
  {:else}
    COULD NOT LOAD THE JOB DATABASE.
  {/if}
</p>

<noscript>
  <p>This filter UI requires JavaScript. The current build of openroles ships data via
    <code>sql.js-httpvfs</code>; results are rendered after the database loads.</p>
</noscript>

{#if dbStatus === "loading"}
  <p class="data-pending">Loading data…</p>
{:else if dbStatus === "error"}
  <p class="data-error" role="alert">
    {dbError ?? "Unknown error loading the database."}
  </p>
{:else}
  {#if queryError}
    <p class="data-error" role="status">{queryError}</p>
  {/if}
  {#if rows.length === 0}
    <p class="data-empty">No roles match the current filters.</p>
  {:else}
    <div class="results-head" role="row">
      <button
        type="button"
        class="col-head col-role"
        onclick={() => clickSort("company")}
        aria-sort={ariaSort("company")}
      >
        ROLE
        {#if ariaSort("company") === "ascending"}
          <span class="arr" aria-hidden="true">↑</span>
        {:else if ariaSort("company") === "descending"}
          <span class="arr" aria-hidden="true">↓</span>
        {/if}
      </button>
      <span class="col-head col-location">LOCATION</span>
      <button
        type="button"
        class="col-head col-level"
        onclick={() => clickSort("level")}
        aria-sort={ariaSort("level")}
      >
        LEVEL
        {#if ariaSort("level") === "ascending"}
          <span class="arr" aria-hidden="true">↑</span>
        {:else if ariaSort("level") === "descending"}
          <span class="arr" aria-hidden="true">↓</span>
        {/if}
      </button>
      <button
        type="button"
        class="col-head col-posted"
        onclick={() => clickSort("posted_at")}
        aria-sort={ariaSort("posted_at")}
      >
        POSTED
        {#if ariaSort("posted_at") === "ascending"}
          <span class="arr" aria-hidden="true">↑</span>
        {:else if ariaSort("posted_at") === "descending"}
          <span class="arr" aria-hidden="true">↓</span>
        {/if}
      </button>
      <span class="col-head col-actions" aria-hidden="true"></span>
    </div>

    <ul class="results" role="list" data-testid="job-results">
      {#each visibleRows as row (row.id)}
        {@const age = formatAge(row.posted_at)}
        {@const stale = row.is_stale === 1}
        {@const staleDays = stale ? staleAgeDays(row.last_seen_at) : 0}
        <li class="job" class:applied={isApplied(row.id)} class:is-stale={stale}>
          <div class="job-cell job-cell--role">
            <h3 class="company">
              <span class="company-name">{row.company}</span>
              {#if stale}
                <span
                  class="stale-badge"
                  title={`Last verified ${(row.last_seen_at ?? "").slice(0, 10)} — the source ATS hasn't responded for ${staleDays} day${staleDays === 1 ? "" : "s"}. The role may still be open.`}
                >STALE · {staleDays}D</span>
              {:else if age.fresh}
                <span class="new-badge" aria-label="new">NEW</span>
              {/if}
              {#if row.is_recruiter_post}
                <span class="recruiter-badge" aria-label="recruiter posting">RECRUITER</span>
              {/if}
            </h3>
            <a
              href={row.url}
              class="job-title"
              rel="noopener noreferrer"
              target="_blank"
              onclick={() => onMarkApplied(row.id)}
            >
              {row.title}
            </a>
          </div>
          <div
            class="job-cell job-cell--location"
            class:is-empty={!row.location_text && !row.workplace_type}
          >
            {row.location_text ?? ""}
            {#if row.workplace_type}
              {#if row.location_text}<span class="rule" aria-hidden="true">·</span>{/if}
              <span class="wt">{row.workplace_type}</span>
            {/if}
          </div>
          <div class="job-cell job-cell--level" class:is-empty={!row.level}>
            {row.level ?? ""}
          </div>
          <div class="job-cell job-cell--posted">
            <span class="age" class:is-new={age.fresh}>{age.label}</span>
            {#if isApplied(row.id)}
              <span class="rule" aria-hidden="true">·</span>
              <span class="applied-badge">applied</span>
            {/if}
          </div>
          <div class="job-cell job-cell--actions">
            <div class="job-actions">
              <button
                type="button"
                class="job-action save"
                aria-pressed={isSaved(row.id)}
                onclick={() => onToggleSaved(row.id)}
              >
                {isSaved(row.id) ? "★ Saved" : "☆ Save"}
              </button>
              <a
                href={`${basePath}/role/?id=${row.id.slice(0, 16)}`}
                class="job-action view"
              >
                View
              </a>
              <a
                href={row.url}
                class="job-action apply"
                rel="noopener noreferrer"
                target="_blank"
                onclick={() => onMarkApplied(row.id)}
              >
                Apply →
              </a>
              <button
                type="button"
                class="job-action ignore"
                aria-pressed={isIgnored(row.id)}
                onclick={() => onToggleIgnored(row.id)}
              >
                {isIgnored(row.id) ? "Unignore" : "Ignore"}
              </button>
            </div>
          </div>
        </li>
      {/each}
    </ul>

    {#if totalPages > 1}
      <nav class="pager" aria-label="Pagination" data-testid="pager">
        <button
          type="button"
          class="pager-edge"
          disabled={!hasPrev}
          onclick={() => gotoPage(state.page - 1)}
          aria-label="Previous page"
        >‹</button>

        <!-- Compact summary; replaced by the numbered list at ≥ 640 px. -->
        <span class="pager-summary">
          PAGE <b>{state.page.toLocaleString()}</b> OF {totalPages.toLocaleString()}
        </span>

        <ol class="pager-pages" role="list">
          {#each pagerPages as token, i (i)}
            {#if token === "ellipsis"}
              <li class="pager-ellipsis" aria-hidden="true">…</li>
            {:else}
              <li>
                <button
                  type="button"
                  class="pager-page"
                  class:is-current={token === state.page}
                  aria-current={token === state.page ? "page" : undefined}
                  onclick={() => gotoPage(token)}
                >{token}</button>
              </li>
            {/if}
          {/each}
        </ol>

        <button
          type="button"
          class="pager-edge"
          disabled={!hasNext}
          onclick={() => gotoPage(state.page + 1)}
          aria-label="Next page"
        >›</button>
      </nav>
    {/if}
  {/if}
{/if}

<style>
  /* Brutalist Press — see specs/visual-theme.md.
     Tokens come from site/src/styles/tokens.css. */

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  /* ---------- Search row ---------- */
  .search-row {
    margin-block-end: var(--space-3);
  }
  .search-label { display: block; }

  .search-help {
    margin-block-start: var(--space-2);
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wide);
  }
  .search-help summary {
    color: var(--color-ink-2);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
    list-style: none;
    user-select: none;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--tap);
    padding: 0 var(--space-2);
  }
  .search-help summary::before {
    content: "?";
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4em;
    height: 1.4em;
    border: var(--rule-1) solid var(--color-ink-2);
    border-radius: 0;
    font-size: var(--text-1);
  }
  .search-help[open] summary { color: var(--color-ink); }
  .search-help ul {
    list-style: none;
    padding: var(--space-2) 0 0 var(--space-3);
    margin: 0;
    display: grid;
    gap: var(--space-1);
  }
  .search-help code {
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    background: transparent;
    padding: 0 var(--space-1);
    border: var(--rule-1) solid var(--color-rule-soft);
  }
  .search-label input {
    width: 100%;
    min-height: var(--tap);
    padding: var(--space-2) var(--space-3);
    border: var(--rule-2) solid var(--color-ink);
    border-radius: 0;
    background: transparent;
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-3);
    font-weight: 600;
  }
  .search-label input::placeholder {
    color: var(--color-ink-3);
  }

  /* ---------- Filter bar (applied chips + add-filter buttons) ---------- */
  .filter-bar {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding-block: var(--space-3);
    border-bottom: var(--rule-1) solid var(--color-rule);
    margin-block-end: var(--space-2);
  }

  .active-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    min-height: var(--tap);
    border: var(--rule-1) solid var(--color-ink);
    border-radius: 0;
    background: var(--color-ink);
    color: var(--color-paper);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .active-chip.accent {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-on-accent);
  }
  .active-chip:hover {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-on-accent);
  }
  .active-chip .x { font-size: var(--text-2); line-height: 1; }

  .add-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    min-height: var(--tap);
    padding: 0 var(--space-3);
    border: var(--rule-1) dashed var(--color-ink);
    border-radius: 0;
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .add-button[aria-expanded="true"],
  .add-button[aria-pressed="true"] {
    background: var(--color-ink);
    color: var(--color-paper);
    border-style: solid;
  }
  .add-button:hover {
    background: var(--color-ink);
    color: var(--color-paper);
    border-style: solid;
  }

  .reset {
    margin-inline-start: auto;
    min-height: var(--tap);
    padding: 0 var(--space-3);
    border: 0;
    background: transparent;
    color: var(--color-accent);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .reset:hover {
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 0.15em;
  }

  /* ---------- Popover ---------- */
  .popover-anchor {
    position: relative;
    display: inline-flex;
  }
  .sort-anchor { margin-inline-start: auto; }

  .popover {
    position: absolute;
    top: calc(100% + var(--space-1));
    left: 0;
    z-index: 50;
    min-width: 240px;
    max-width: calc(100vw - var(--space-4) * 2);
    padding: var(--space-3);
    background: var(--color-paper);
    border: var(--rule-2) solid var(--color-ink);
    box-shadow: var(--space-1) var(--space-1) 0 0 var(--color-ink);
  }
  .popover--narrow { min-width: 200px; }
  .popover--right { right: 0; left: auto; }

  .chip-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    max-width: 360px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    min-height: var(--tap);
    border: var(--rule-1) solid var(--color-ink);
    border-radius: 0;
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .chip:has(input:checked) {
    background: var(--color-ink);
    color: var(--color-paper);
  }
  .chip input { accent-color: var(--color-accent); }

  .radio-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-1);
  }
  .radio {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-2);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-2);
    cursor: pointer;
    min-height: var(--tap);
  }
  .radio:hover { background: var(--color-paper); }
  .radio input { accent-color: var(--color-accent); }

  .number-label {
    display: grid;
    gap: var(--space-2);
    color: var(--color-ink-2);
    font-family: var(--font-display);
    font-size: var(--text-00);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .number-label input {
    min-height: var(--tap);
    padding: 0 var(--space-3);
    border: var(--rule-1) solid var(--color-ink);
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-2);
    font-weight: 600;
  }

  /* ---------- Status / states ---------- */
  .results-status {
    margin: var(--space-3) 0;
    padding: 0;
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .results-status b { color: var(--color-accent); font-weight: 700; }
  .results-status .status-scope { color: var(--color-accent); font-weight: 700; }

  .data-pending,
  .data-empty {
    padding: var(--space-4) 0;
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
  }

  .data-error {
    padding: var(--space-3);
    margin-block: var(--space-3);
    color: var(--color-on-accent);
    background: var(--color-accent);
    border: var(--rule-1) solid var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wide);
  }

  /* ---------- Result list ---------- */
  .results-head { display: none; }

  .results {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0;
    border-top: var(--rule-2) solid var(--color-rule);
  }

  .job {
    padding: var(--space-4) 0;
    border-bottom: var(--rule-1) solid var(--color-rule);
    display: grid;
    gap: var(--space-2);
  }
  .job.applied { opacity: 0.7; }

  /* Company name is the byline / publisher mark for the row. Smaller mono
     caps in accent red — distinct color and family from the role title so
     users don't conflate the two. */
  .company {
    margin: 0;
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    line-height: 1.2;
    text-transform: uppercase;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
  }
  .company-name { color: var(--color-accent); }
  .new-badge {
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-00);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    border: var(--rule-1) solid var(--color-accent);
    padding: 0 var(--space-1);
  }
  .recruiter-badge {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-00);
    font-weight: 700;
    letter-spacing: var(--track-wider);
  }

  /* Stale badge — muted ink-3, mono caps, framed in a thin ink-3 border so
     the cue reads as "this is muted state" not "this is decoration". Per
     specs/visual-theme.md §State discipline, muted ink-3 is reserved for
     negative-but-not-error states; specs/role-lifecycle.md §Filter
     behavior owns this badge. */
  .stale-badge {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-00);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    border: var(--rule-1) solid var(--color-ink-3);
    padding: 0 var(--space-1);
    cursor: help;
  }
  /* The whole stale row dims to 0.6 so users can scan past it without
     having to read every badge. Tooltip + filter chip handle the deeper
     "why is this dim?" question. */
  .job.is-stale {
    opacity: 0.6;
  }

  /* Role title is the most prominent element in each row — biggest type,
     primary ink, display sans for at-a-glance scanability. The company
     above it is in accent red mono so the two never visually merge. */
  .job-title {
    display: inline-block;
    margin-top: var(--space-1);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-4);
    font-weight: 800;
    letter-spacing: var(--track-tight);
    line-height: 1.1;
    text-transform: uppercase;
    text-decoration: none;
  }
  .job-title:hover {
    color: var(--color-accent);
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 0.15em;
  }
  @media (min-width: 768px) {
    .job-title { font-size: var(--text-5); }
  }
  @media (min-width: 960px) {
    .job-title { font-size: var(--text-4); }
  }

  .job-cell--location {
    color: var(--color-ink-2);
    font-family: var(--font-serif);
    font-size: var(--text-2);
  }
  .job-cell--location .wt {
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wide);
    color: var(--color-ink-2);
  }
  .job-cell--location .rule { color: var(--color-ink-3); }

  .job-cell--level {
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
  }
  .job-cell--posted {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
  }
  .job-cell--posted .age.is-new::before { content: "● "; color: var(--color-accent); }
  .job-cell--posted .applied-badge { color: var(--color-accent); font-weight: 700; }

  /* On mobile cells stack; collapse empty ones so we don't show stray
     placeholders between data lines. On desktop the grid keeps the
     placeholder reserved (visibility:hidden) so columns stay aligned. */
  .job-cell.is-empty { display: none; }
  @media (min-width: 960px) {
    .job-cell.is-empty { display: block; visibility: hidden; }
  }

  .job-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .job-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--tap);
    padding: 0 var(--space-3);
    border: var(--rule-1) solid var(--color-ink);
    border-radius: 0;
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    text-decoration: none;
    cursor: pointer;
  }
  .job-action:hover:not(:disabled) {
    background: var(--color-ink);
    color: var(--color-paper);
  }
  .job-action[aria-pressed="true"] {
    background: var(--color-ink);
    color: var(--color-paper);
  }
  .job-action.apply {
    background: var(--color-accent);
    color: var(--color-on-accent);
    border-color: var(--color-accent);
  }
  .job-action.apply:hover {
    background: var(--color-ink);
    border-color: var(--color-ink);
    color: var(--color-paper);
  }

  /* ---------- Pager ----------
     Single-row layout. Below 640 px the numbered list collapses to a
     compact "PAGE N OF M" summary so prev/next stay reachable on the
     same row at every viewport. Buttons are centered as a tight group. */
  .pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    padding-block: var(--space-4);
    margin-block-start: var(--space-4);
    border-top: var(--rule-4) solid var(--color-rule);
  }
  .pager-edge,
  .pager-page {
    min-height: var(--tap);
    min-width: var(--tap);
    padding: 0 var(--space-3);
    border: var(--rule-1) solid var(--color-ink);
    border-radius: 0;
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .pager-edge:hover:not(:disabled),
  .pager-page:hover { background: var(--color-ink); color: var(--color-paper); }
  .pager-edge:disabled { opacity: 0.4; cursor: not-allowed; }
  .pager-pages {
    display: none; /* mobile default: replaced by .pager-summary */
  }
  .pager-summary {
    /* On mobile the summary fills the gap between prev and next so the
       three controls span the available row width. */
    flex: 1 1 auto;
    text-align: center;
    padding-inline: var(--space-2);
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .pager-summary b { color: var(--color-accent); font-weight: 700; }
  .pager-page.is-current {
    background: var(--color-accent);
    color: var(--color-on-accent);
    border-color: var(--color-accent);
  }
  .pager-ellipsis {
    align-self: center;
    padding: 0 var(--space-2);
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-0);
  }

  @media (min-width: 640px) {
    .pager-pages {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      gap: var(--space-1);
    }
    .pager-summary { display: none; }
  }

  /* ---------- Desktop layout: results as a table-grid with sortable columns ---------- */
  @media (min-width: 960px) {
    .results-head,
    .job {
      display: grid;
      grid-template-columns:
        minmax(0, 2.4fr)
        minmax(0, 1.5fr)
        minmax(0, 0.7fr)
        minmax(0, 0.7fr)
        minmax(0, 1.6fr);
      column-gap: var(--space-3);
      align-items: start;
      padding-block: var(--space-3);
    }
    .results-head {
      display: grid;
      padding-block: var(--space-2);
      border-block: var(--rule-2) solid var(--color-rule);
    }
    .col-head {
      padding: 0;
      margin: 0;
      border: 0;
      background: transparent;
      color: var(--color-ink);
      font-family: var(--font-display);
      font-size: var(--text-00);
      font-weight: 800;
      letter-spacing: var(--track-wider);
      text-transform: uppercase;
      text-align: left;
      cursor: pointer;
      min-height: var(--tap);
    }
    .col-head:not(button) { cursor: default; }
    .col-head .arr { color: var(--color-accent); margin-left: var(--space-1); }

    .results { border-top: 0; }
    .job {
      gap: 0;
      border-bottom: var(--rule-1) solid var(--color-rule);
    }
    .job-cell { font-family: var(--font-serif); font-size: var(--text-2); }
    .job-cell--role { display: grid; gap: var(--space-1); }
    .job-cell--actions { justify-self: end; }
    .job-actions { flex-wrap: nowrap; gap: var(--space-1); }
    .job-action { padding: 0 var(--space-2); font-size: var(--text-0); }
  }
</style>
