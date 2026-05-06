<script lang="ts">
import { totalActiveCount } from "../../lib/filter-active-count.ts";
import { DEFAULT_FILTER_STATE, type FilterState } from "../../lib/filter-state.ts";
import FilterGroups from "./FilterGroups.svelte";

interface Props {
  filters: FilterState;
  onPatch: (patch: Partial<FilterState>) => void;
  savedCount: number;
  appliedCount: number;
  ignoredCount: number;
  optionCounts?: {
    ats: Record<string, number>;
    level: Record<string, number>;
    wt: Record<string, number>;
  };
}

let { filters, onPatch, savedCount, appliedCount, ignoredCount, optionCounts }: Props = $props();

let confirmingReset = $state(false);

const activeCount = $derived(totalActiveCount(filters));

function onResetClick() {
  if (activeCount >= 3) {
    confirmingReset = true;
  } else {
    doReset();
  }
}

function doReset() {
  confirmingReset = false;
  onPatch({ ...DEFAULT_FILTER_STATE });
}

function cancelReset() {
  confirmingReset = false;
}
</script>

<aside class="sidebar" aria-label="Filters">
  <header class="sidebar-head">
    <h2 class="sidebar-title">Filters</h2>
    {#if activeCount > 0}
      <span class="active-pill" aria-live="polite">{activeCount} active</span>
    {/if}
  </header>

  <!-- collapsible={true}: each group is an accordion. Without this, the
       full sidebar runs ~1260 px tall and exceeds an 877 px viewport-bound
       window, forcing an internal scrollbar inside the page's own scroll.
       Collapsing the long-tail groups (Workplace / Posted / Min comp /
       Status / Personal) by default keeps the sidebar in the viewport
       without a second scroll context. -->
  <FilterGroups
    filters={filters}
    onPatch={onPatch}
    savedCount={savedCount}
    appliedCount={appliedCount}
    ignoredCount={ignoredCount}
    optionCounts={optionCounts}
    collapsible={true}
  />

  <footer class="sidebar-foot">
    {#if confirmingReset}
      <div class="reset-confirm" role="alertdialog" aria-label="Reset all filters?">
        <span class="reset-q">Reset all filters?</span>
        <button type="button" class="reset-yes" onclick={doReset}>Yes</button>
        <button type="button" class="reset-cancel" onclick={cancelReset}>Cancel</button>
      </div>
    {:else}
      <button
        type="button"
        class="reset-all"
        disabled={activeCount === 0}
        onclick={onResetClick}
      >Reset all</button>
    {/if}
    <!-- Result count intentionally not duplicated here; the role-count
         already lives at the top of the role table (.results-status). -->
  </footer>
</aside>

<style>
  .sidebar {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-3);
    border: var(--rule-2) solid var(--color-ink);
    background: var(--color-paper);
    /* Without min-width:0 the grid container expands to its largest child's
       min-content, which lets a wide chip-row push the sidebar past the
       parent column's max-width. Force the grid to obey the parent. */
    min-width: 0;
  }
  .sidebar-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    padding-block-end: var(--space-2);
    border-bottom: var(--rule-4) solid var(--color-ink);
  }
  .sidebar-title {
    margin: 0;
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-3);
    font-weight: 800;
    letter-spacing: var(--track-tight);
    text-transform: uppercase;
  }
  .active-pill {
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }

  .sidebar-foot {
    display: grid;
    gap: var(--space-2);
    padding-block-start: var(--space-3);
    border-top: var(--rule-2) solid var(--color-ink);
  }
  .reset-all {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--color-accent);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
    text-align: left;
    min-height: var(--tap);
  }
  .reset-all:hover:not(:disabled) {
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }
  .reset-all:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .reset-confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    border: var(--rule-2) solid var(--color-accent);
    background: var(--color-accent-soft);
  }
  .reset-q {
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
  }
  .reset-yes,
  .reset-cancel {
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
    cursor: pointer;
  }
  .reset-yes {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-on-accent);
  }

</style>
