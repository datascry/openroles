<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: ATS_IDS / WORKPLACE_TYPES are used in the Svelte template (each block) below

import type { Job } from "@openroles/shared";
import { ATS_IDS, LEVELS, WORKPLACE_TYPES } from "@openroles/shared/constants";
import { onMount } from "svelte";
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

const PAGE_SIZE = 50;

// Pick the columns the SELECT projects so the row type stays in lockstep with
// shared/src/schema/job.ts. SQLite returns booleans as 0/1, so override the
// is_recruiter_post field. `import type { Job }` is erased at compile time —
// no zod weight reaches the client bundle.
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
  | "url"
> & { is_recruiter_post: 0 | 1 };

type DbStatus = "loading" | "ready" | "error";

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

// localStorage-backed sets for saved / applied / ignored job ids. Read once
// on mount; each toggle re-reads + writes to keep cross-tab consistency
// loose-but-correct (a write from another tab is picked up on next render).
let savedIds: ReadonlyArray<string> = $state([]);
let appliedIds: ReadonlyArray<string> = $state([]);
let ignoredIds: ReadonlyArray<string> = $state([]);
let hideIgnored = $state(true);

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

const visibleRows = $derived(hideIgnored ? rows.filter((r) => !isIgnored(r.id)) : rows);

// Debounce window for query execution. Coalesces double-clicks and rapid
// chip toggles so the worker does not pile up superseded queries behind the
// live one. Audit-driven (Phase 8 review M4); 50 ms is fast enough to feel
// instant, slow enough to coalesce.
const QUERY_DEBOUNCE_MS = 50;
let queryDebounceHandle: ReturnType<typeof setTimeout> | undefined;

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
  qDebounceHandle = setTimeout(() => updateState({ q: value }), 250);
}

function toggleAts(id: (typeof ATS_IDS)[number]) {
  const next = state.ats.includes(id) ? state.ats.filter((x) => x !== id) : [...state.ats, id];
  updateState({ ats: next });
}

function toggleLevel(id: NonNullable<(typeof LEVELS)[number]>) {
  const next = state.level.includes(id)
    ? state.level.filter((x) => x !== id)
    : [...state.level, id];
  updateState({ level: next });
}

function toggleWt(id: (typeof WORKPLACE_TYPES)[number]) {
  const next = state.wt.includes(id) ? state.wt.filter((x) => x !== id) : [...state.wt, id];
  updateState({ wt: next });
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

const totalPages = $derived(Math.max(1, Math.ceil(totalCount / PAGE_SIZE)));
const hasPrev = $derived(state.page > 1);
const hasNext = $derived(state.page < totalPages);

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

async function runQuery(currentState: FilterState, db: ClientDb): Promise<void> {
  const token = ++queryToken;
  const plan = buildFilterQuery(currentState);
  const countPlan = buildFilterCountQuery(currentState);
  try {
    const [resultRows, countRows] = await Promise.all([
      db.query<JobRow>(plan.sql, plan.params),
      db.query<{ c: number }>(countPlan.sql, countPlan.params),
    ]);
    if (token !== queryToken) return; // a newer query already started
    rows = resultRows;
    totalCount = countRows[0]?.c ?? 0;
    queryError = null;
    if (import.meta.env.DEV && typeof console !== "undefined" && console.debug) {
      console.debug("filter-table:query", {
        rows: resultRows.length,
        total: totalCount,
        sql: plan.sql,
      });
    }
  } catch (err) {
    if (token !== queryToken) return;
    // Per-query failure (transient): surface the error inline but keep the
    // worker live so subsequent state changes can retry. Reserve dbStatus
    // = "error" for terminal load failures (worker bootstrap / manifest
    // fetch). Audit-driven (Phase 8 review M3).
    queryError = err instanceof Error ? err.message : String(err);
    // biome-ignore lint/suspicious/noConsole: dev-only diagnostic for query failures
    if (import.meta.env.DEV && typeof console !== "undefined" && console.error) {
      console.error(
        "filter-table:query-failed",
        err,
        "plan.sql=",
        plan.sql,
        "params=",
        JSON.stringify(plan.params),
      );
    }
  }
}

$effect(() => {
  // Read-track the fields runQuery depends on so the effect re-fires.
  const snapshot = state;
  const db = clientDb;
  if (!db || dbStatus !== "ready") return;
  if (queryDebounceHandle) clearTimeout(queryDebounceHandle);
  queryDebounceHandle = setTimeout(() => {
    void runQuery(snapshot, db);
  }, QUERY_DEBOUNCE_MS);
});

function formatPostedAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  // Round-trip through Date so the YYYY-MM-DD slice survives any future
  // schema drift (e.g. RFC 3339 offsets like `+00:00` instead of `Z`).
  // Audit-driven (Phase 8 review m7).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}
</script>

<section class="filters" aria-label="Filters">
  <label class="search-label">
    <span class="visually-hidden">Search</span>
    <input
      type="search"
      placeholder="Search title, company, or description"
      maxlength="256"
      value={qInput}
      oninput={(e) => onQInput((e.currentTarget as HTMLInputElement).value)}
    />
  </label>

  <fieldset>
    <legend>ATS</legend>
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
  </fieldset>

  <fieldset>
    <legend>Level</legend>
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
  </fieldset>

  <fieldset>
    <legend>Workplace</legend>
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
  </fieldset>

  <label class="since-label">
    <span>Posted within</span>
    <select
      value={state.since}
      onchange={(e) => setSince((e.currentTarget as HTMLSelectElement).value as SinceWindow)}
    >
      {#each SINCE_OPTIONS as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </label>

  <label class="min-comp-label">
    <span>Min comp (USD)</span>
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

  <label class="recruiter-toggle">
    <input
      type="checkbox"
      checked={state.hideRecruiter}
      onchange={(e) =>
        updateState({ hideRecruiter: (e.currentTarget as HTMLInputElement).checked })}
    />
    <span>Hide recruiter posts</span>
  </label>

  <label class="recruiter-toggle">
    <input
      type="checkbox"
      checked={hideIgnored}
      onchange={(e) => (hideIgnored = (e.currentTarget as HTMLInputElement).checked)}
    />
    <span>Hide ignored ({ignoredIds.length})</span>
  </label>

  <label class="sort-label">
    <span>Sort</span>
    <select
      value={state.sort}
      onchange={(e) => setSort((e.currentTarget as HTMLSelectElement).value as SortOption)}
    >
      <option value="posted_at:desc">Newest first</option>
      <option value="posted_at:asc">Oldest first</option>
      <option value="first_seen:desc">First seen</option>
      <option value="company:asc">Company A→Z</option>
      <option value="company:desc">Company Z→A</option>
      <option value="level:asc">Level: junior → senior</option>
    </select>
  </label>

  <button type="button" class="reset" onclick={resetAll}>Reset</button>
</section>

<p class="results-status" aria-live="polite" aria-busy={dbStatus === "loading"}>
  {#if dbStatus === "ready"}
    {totalCount.toLocaleString()} {totalCount === 1 ? "job" : "jobs"} ·
    sort: {state.sort} · page {state.page}
  {:else if dbStatus === "loading"}
    {state.q ? `Search: "${state.q}"` : "All jobs"} · sort: {state.sort} · page {state.page}
  {:else}
    Could not load the job database.
  {/if}
</p>

<noscript>
  <p>This filter UI requires JavaScript. The current build of openroles ships data via
    <code>sql.js-httpvfs</code>; results are rendered after the database loads.</p>
</noscript>

{#if dbStatus === "loading"}
  <p class="data-pending">
    Loading data…
  </p>
{:else if dbStatus === "error"}
  <p class="data-error" role="alert">
    {dbError ?? "Unknown error loading the database."}
  </p>
{:else}
  {#if queryError}
    <p class="data-error" role="status">{queryError}</p>
  {/if}
  {#if rows.length === 0}
    <p class="data-empty" aria-live="polite">No jobs match the current filters.</p>
  {:else}
  <ul class="results" role="list" data-testid="job-results">
    {#each visibleRows as row (row.id)}
      <li class="job" class:applied={isApplied(row.id)}>
        <a
          href={row.url}
          class="job-title"
          rel="noopener noreferrer"
          target="_blank"
          onclick={() => onMarkApplied(row.id)}
        >
          {row.title}
        </a>
        <p class="job-meta">
          <span class="company">{row.company}</span>
          {#if row.location_text}
            <span class="location"> · {row.location_text}</span>
          {/if}
          {#if row.level}
            <span class="level"> · {row.level}</span>
          {/if}
          {#if row.workplace_type}
            <span class="wt"> · {row.workplace_type}</span>
          {/if}
        </p>
        <p class="job-meta secondary">
          <span class="ats">{row.ats}</span>
          <span class="posted-at"> · posted {formatPostedAt(row.posted_at)}</span>
          {#if row.is_recruiter_post}
            <span class="recruiter-badge"> · recruiter</span>
          {/if}
          {#if isApplied(row.id)}
            <span class="applied-badge"> · applied</span>
          {/if}
        </p>
        <div class="job-actions">
          <button
            type="button"
            class="job-action save"
            aria-pressed={isSaved(row.id)}
            onclick={() => onToggleSaved(row.id)}
          >
            {isSaved(row.id) ? "★ Saved" : "☆ Save"}
          </button>
          <button
            type="button"
            class="job-action ignore"
            aria-pressed={isIgnored(row.id)}
            onclick={() => onToggleIgnored(row.id)}
          >
            {isIgnored(row.id) ? "Unignore" : "Ignore"}
          </button>
        </div>
      </li>
    {/each}
  </ul>
  {#if totalPages > 1}
    <nav class="pager" aria-label="Pagination" data-testid="pager">
      <button
        type="button"
        disabled={!hasPrev}
        onclick={() => gotoPage(state.page - 1)}
        aria-label="Previous page"
      >‹ Prev</button>
      <span class="pager-status" aria-live="polite">
        Page {state.page} of {totalPages.toLocaleString()}
      </span>
      <button
        type="button"
        disabled={!hasNext}
        onclick={() => gotoPage(state.page + 1)}
        aria-label="Next page"
      >Next ›</button>
    </nav>
  {/if}
  {/if}
{/if}

<style>
  .filters {
    display: grid;
    gap: var(--size-3, 1rem);
    padding: var(--size-3, 1rem);
  }
  .search-label {
    display: block;
  }
  .search-label input {
    width: 100%;
    min-height: 44px;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--surface-3, #ccc);
    border-radius: var(--radius-2, 4px);
    font-size: var(--font-size-2, 1rem);
  }
  fieldset {
    border: none;
    padding: 0;
    margin: 0;
  }
  legend {
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--surface-3, #ccc);
    border-radius: 9999px;
    margin: 0.125rem 0.25rem 0.125rem 0;
    min-height: 32px;
  }
  .chip input {
    accent-color: var(--link, #0366d6);
  }
  .recruiter-toggle,
  .sort-label,
  .since-label,
  .min-comp-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .min-comp-label input,
  .since-label select,
  .sort-label select {
    min-height: 36px;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--surface-3, #ccc);
    border-radius: var(--radius-2, 4px);
    font-size: var(--font-size-1, 0.875rem);
  }
  .min-comp-label input {
    width: 8rem;
  }
  .reset {
    align-self: start;
    min-height: 44px;
    padding: 0 1rem;
    border: 1px solid var(--surface-3, #ccc);
    background: var(--surface-1, #fff);
    border-radius: var(--radius-2, 4px);
  }
  .results-status {
    padding: 0 var(--size-3, 1rem);
    color: var(--text-2, #555);
    font-size: var(--font-size-1, 0.875rem);
  }
  .data-pending,
  .data-empty {
    padding: var(--size-3, 1rem);
    color: var(--text-2, #555);
  }
  .data-error {
    padding: var(--size-3, 1rem);
    color: var(--text-2, #b00020);
    background: var(--surface-2, #fff5f5);
    border: 1px solid currentcolor;
    border-radius: var(--radius-2, 4px);
    margin: var(--size-3, 1rem);
  }
  .results {
    list-style: none;
    padding: 0 var(--size-3, 1rem);
    margin: 0;
    display: grid;
    gap: var(--size-3, 1rem);
  }
  .job {
    padding: var(--size-3, 0.75rem);
    border: 1px solid var(--surface-3, #ddd);
    border-radius: var(--radius-2, 4px);
    background: var(--surface-1, #fff);
  }
  .job-title {
    font-weight: 600;
    font-size: var(--font-size-3, 1.125rem);
    color: var(--link, #0366d6);
  }
  .job-meta {
    margin: 0.25rem 0 0;
    color: var(--text-2, #555);
    font-size: var(--font-size-1, 0.875rem);
  }
  .job-meta.secondary {
    color: var(--text-3, #777);
  }
  .job.applied {
    opacity: 0.7;
  }
  .applied-badge {
    color: var(--green-7, #1a7f37);
    font-weight: 600;
  }
  .job-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .job-action {
    min-height: 36px;
    padding: 0 0.75rem;
    border: 1px solid var(--surface-3, #ccc);
    background: var(--surface-1, #fff);
    border-radius: var(--radius-2, 4px);
    font-size: var(--font-size-1, 0.875rem);
    cursor: pointer;
  }
  .job-action[aria-pressed="true"] {
    background: var(--surface-2, #f6f8fa);
    border-color: var(--link, #0366d6);
  }
  .pager {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: var(--size-3, 1rem);
    margin-top: var(--size-3, 1rem);
  }
  .pager button {
    min-height: 44px;
    padding: 0 1rem;
    border: 1px solid var(--surface-3, #ccc);
    background: var(--surface-1, #fff);
    border-radius: var(--radius-2, 4px);
    font-size: var(--font-size-1, 0.875rem);
  }
  .pager button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .pager-status {
    color: var(--text-2, #555);
    font-size: var(--font-size-1, 0.875rem);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
