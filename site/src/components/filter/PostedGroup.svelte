<script lang="ts">
import {
  DEFAULT_FILTER_STATE,
  type FilterState,
  type SinceWindow,
} from "../../lib/filter-state.ts";
import GroupCard from "./GroupCard.svelte";

interface Props {
  filters: Pick<FilterState, "since">;
  onPatch: (patch: Partial<FilterState>) => void;
  collapsible?: boolean;
  expanded?: boolean;
  onExpandToggle?: (expanded: boolean) => void;
}

let { filters, onPatch, collapsible, expanded, onExpandToggle }: Props = $props();

const OPTIONS: ReadonlyArray<{ id: SinceWindow; label: string }> = [
  { id: "24h", label: "Last 24h" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "all", label: "Any time" },
];

function pick(id: SinceWindow) {
  onPatch({ since: id });
}
</script>

<GroupCard
  id="posted"
  title="Posted"
  count={filters.since !== DEFAULT_FILTER_STATE.since ? 1 : 0}
  {collapsible}
  {expanded}
  {onExpandToggle}
>
  <div class="chip-list" role="group" aria-label="Posted within">
    {#each OPTIONS as opt (opt.id)}
      <button
        type="button"
        class="chip"
        class:is-active={filters.since === opt.id}
        aria-pressed={filters.since === opt.id}
        onclick={() => pick(opt.id)}
      >
        {opt.label}
      </button>
    {/each}
  </div>
</GroupCard>

<style>
  .chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    min-height: var(--tap);
    padding: var(--space-1) var(--space-2);
    border: var(--rule-1) solid var(--color-rule-soft);
    border-radius: 0;
    background: transparent;
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    text-transform: uppercase;
    letter-spacing: var(--track-wide);
    cursor: pointer;
    transition: background-color 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out;
  }
  /* :not(.is-active) prevents the hover rule from clobbering active-chip
     contrast — without it, hovering an active chip would paint the
     ink-colored text on the ink-colored bg (invisible). */
  .chip:hover:not(.is-active) { border-color: var(--color-ink); color: var(--color-ink); }
  .chip.is-active {
    background: var(--color-ink);
    border-color: var(--color-ink);
    color: var(--color-paper);
  }
  .chip.is-active:hover {
    background: var(--color-ink);
    color: var(--color-paper);
    border-color: var(--color-accent);
  }
</style>
