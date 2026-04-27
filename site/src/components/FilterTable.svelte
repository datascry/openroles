<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: ATS_IDS / WORKPLACE_TYPES are used in the Svelte template (each block) below
import { ATS_IDS, LEVELS, WORKPLACE_TYPES } from "@openroles/shared/constants";
import { onMount } from "svelte";
import { type ClientDb, loadClientDb } from "../lib/client-db.ts";
import { buildFilterCountQuery, buildFilterQuery } from "../lib/filter-sql.ts";
import {
  DEFAULT_FILTER_STATE,
  decodeFilterState,
  encodeFilterState,
  type FilterState,
  type SortOption,
} from "../lib/filter-state.ts";

interface Props {
  basePath?: string;
}

const { basePath = "" }: Props = $props();

const NON_NULL_LEVELS = LEVELS.filter((l): l is NonNullable<(typeof LEVELS)[number]> => l !== null);

interface JobRow {
  id: string;
  ats: string;
  tenant_slug: string;
  title: string;
  company: string;
  location_text: string | null;
  level: string | null;
  workplace_type: string | null;
  is_recruiter_post: number;
  posted_at: string | null;
  url: string;
}

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
let rows: JobRow[] = $state([]);
let totalCount: number = $state(0);
let queryToken: number = 0;

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

function resetAll() {
  state = { ...DEFAULT_FILTER_STATE };
  qInput = "";
  syncUrl(state);
}

onMount(async () => {
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
    if (typeof console !== "undefined" && console.debug) {
      console.debug("filter-table:query", {
        rows: resultRows.length,
        total: totalCount,
        sql: plan.sql,
      });
    }
  } catch (err) {
    if (token !== queryToken) return;
    dbStatus = "error";
    dbError = err instanceof Error ? err.message : String(err);
    if (typeof console !== "undefined" && console.error) {
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
  if (clientDb && dbStatus === "ready") {
    void runQuery(state, clientDb);
  }
});

function formatPostedAt(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
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

  <label class="recruiter-toggle">
    <input
      type="checkbox"
      checked={state.hideRecruiter}
      onchange={(e) =>
        updateState({ hideRecruiter: (e.currentTarget as HTMLInputElement).checked })}
    />
    <span>Hide recruiter posts</span>
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

<p class="results-status" aria-live="polite">
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
  <p class="data-pending" aria-live="polite" role="status">
    Loading data…
  </p>
{:else if dbStatus === "error"}
  <p class="data-error" role="alert">
    {dbError ?? "Unknown error loading the database."}
  </p>
{:else if rows.length === 0}
  <p class="data-empty" aria-live="polite">No jobs match the current filters.</p>
{:else}
  <ul class="results" role="list" data-testid="job-results">
    {#each rows as row (row.id)}
      <li class="job">
        <a href={row.url} class="job-title" rel="noopener noreferrer" target="_blank">
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
        </p>
      </li>
    {/each}
  </ul>
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
  .sort-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
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
