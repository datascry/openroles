<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: ATS_IDS / WORKPLACE_TYPES are used in the Svelte template (each block) below
import { ATS_IDS, LEVELS, WORKPLACE_TYPES } from "@openroles/shared/constants";
import {
  DEFAULT_FILTER_STATE,
  decodeFilterState,
  encodeFilterState,
  type FilterState,
  type SortOption,
} from "../lib/filter-state.ts";

const NON_NULL_LEVELS = LEVELS.filter((l): l is NonNullable<(typeof LEVELS)[number]> => l !== null);

let state: FilterState = $state(
  typeof window === "undefined"
    ? DEFAULT_FILTER_STATE
    : decodeFilterState(window.location.search.replace(/^\?/, "")),
);

let qInput = $state(state.q);
let qDebounceHandle: ReturnType<typeof setTimeout> | undefined;

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

<p class="results-status">
  {state.q ? `Search: "${state.q}"` : "All jobs"} · sort: {state.sort} · page {state.page}
</p>

<noscript>
  <p>This filter UI requires JavaScript. The current build of openroles ships data via
    <code>sql.js-httpvfs</code>; results are rendered after the database loads.</p>
</noscript>

<p class="data-pending" aria-live="polite" role="status">
  Loading data…
</p>

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
  .data-pending {
    padding: var(--size-3, 1rem);
    color: var(--text-2, #555);
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
