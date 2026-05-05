<script lang="ts">
import type { FilterState, ShowOnly } from "../../lib/filter-state.ts";
import GroupCard from "./GroupCard.svelte";

interface Props {
  filters: Pick<FilterState, "showOnly">;
  onPatch: (patch: Partial<FilterState>) => void;
  savedCount: number;
  appliedCount: number;
  ignoredCount: number;
  collapsible?: boolean;
  expanded?: boolean;
  onExpandToggle?: (expanded: boolean) => void;
}

let {
  filters,
  onPatch,
  savedCount,
  appliedCount,
  ignoredCount,
  collapsible,
  expanded,
  onExpandToggle,
}: Props = $props();

const ROWS: ReadonlyArray<{ id: ShowOnly; label: string; getCount: () => number }> = [
  { id: "saved", label: "Saved", getCount: () => savedCount },
  { id: "applied", label: "Applied", getCount: () => appliedCount },
  { id: "ignored", label: "Ignored", getCount: () => ignoredCount },
];

function pick(id: ShowOnly) {
  onPatch({ showOnly: filters.showOnly === id ? undefined : id });
}
</script>

<GroupCard
  id="personal"
  title="Personal"
  count={filters.showOnly !== undefined ? 1 : 0}
  {collapsible}
  {expanded}
  {onExpandToggle}
>
  <ul class="switch-list" role="list">
    {#each ROWS as row (row.id)}
      {@const isOn = filters.showOnly === row.id}
      {@const c = row.getCount()}
      {@const empty = c === 0}
      <li>
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-disabled={empty}
          disabled={empty && !isOn}
          title={empty && !isOn ? "Save a role first." : undefined}
          class="switch-row"
          class:is-empty={empty && !isOn}
          onclick={() => { if (!empty || isOn) pick(row.id); }}
        >
          <span class="label">{row.label}<span class="count">· {c}</span></span>
          <span class="switch" aria-hidden="true" data-on={isOn}>
            <span class="thumb"></span>
          </span>
        </button>
      </li>
    {/each}
  </ul>
</GroupCard>

<style>
  .switch-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-1);
  }
  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    min-height: var(--tap);
    padding: var(--space-1) var(--space-2);
    border: 0;
    background: transparent;
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
  }
  .switch-row:hover:not(:disabled) { color: var(--color-accent); }
  .switch-row.is-empty { opacity: 0.5; cursor: not-allowed; }
  .count {
    margin-inline-start: var(--space-1);
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-weight: 400;
  }
  .switch {
    position: relative;
    display: inline-block;
    width: 36px;
    height: 20px;
    border: var(--rule-1) solid var(--color-ink);
    background: transparent;
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: var(--color-ink-3);
    transition: transform 120ms ease-out, background-color 120ms ease-out;
  }
  .switch[data-on="true"] .thumb {
    transform: translateX(16px);
    background: var(--color-accent);
  }
</style>
