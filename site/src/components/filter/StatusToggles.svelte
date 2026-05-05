<script lang="ts">
import type { FilterState } from "../../lib/filter-state.ts";
import GroupCard from "./GroupCard.svelte";

interface Props {
  filters: Pick<FilterState, "hideRecruiter" | "hideStale">;
  onPatch: (patch: Partial<FilterState>) => void;
  collapsible?: boolean;
  expanded?: boolean;
  onExpandToggle?: (expanded: boolean) => void;
}

let { filters, onPatch, collapsible, expanded, onExpandToggle }: Props = $props();

const count = $derived((filters.hideRecruiter ? 1 : 0) + (filters.hideStale ? 1 : 0));
</script>

<GroupCard
  id="status"
  title="Status"
  count={count}
  {collapsible}
  {expanded}
  {onExpandToggle}
>
  <ul class="switch-list" role="list">
    <li>
      <button
        type="button"
        role="switch"
        aria-checked={filters.hideRecruiter}
        class="switch-row"
        onclick={() => onPatch({ hideRecruiter: !filters.hideRecruiter })}
      >
        <span class="label">Hide recruiter posts</span>
        <span class="switch" aria-hidden="true" data-on={filters.hideRecruiter}>
          <span class="thumb"></span>
        </span>
      </button>
    </li>
    <li>
      <button
        type="button"
        role="switch"
        aria-checked={filters.hideStale}
        class="switch-row"
        onclick={() => onPatch({ hideStale: !filters.hideStale })}
      >
        <span class="label">Verified only (hide stale)</span>
        <span class="switch" aria-hidden="true" data-on={filters.hideStale}>
          <span class="thumb"></span>
        </span>
      </button>
    </li>
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
  .switch-row:hover { background: var(--color-paper); color: var(--color-accent); }
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
