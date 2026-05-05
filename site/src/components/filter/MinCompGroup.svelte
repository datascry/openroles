<script lang="ts">
import type { FilterState } from "../../lib/filter-state.ts";
import GroupCard from "./GroupCard.svelte";

interface Props {
  filters: Pick<FilterState, "minComp">;
  onPatch: (patch: Partial<FilterState>) => void;
  collapsible?: boolean;
  expanded?: boolean;
  onExpandToggle?: (expanded: boolean) => void;
}

let { filters, onPatch, collapsible, expanded, onExpandToggle }: Props = $props();

const STEP = 5_000;

let inputValue = $state(filters.minComp ?? "");

$effect(() => {
  inputValue = filters.minComp ?? "";
});

function commit(raw: string | number) {
  if (raw === "" || raw === undefined || raw === null) {
    onPatch({ minComp: undefined });
    return;
  }
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    onPatch({ minComp: undefined });
    return;
  }
  onPatch({ minComp: n });
}

function step(delta: number) {
  const cur = filters.minComp ?? 0;
  const next = Math.max(0, cur + delta);
  commit(next);
}
</script>

<GroupCard
  id="minComp"
  title="Min comp"
  count={filters.minComp !== undefined && filters.minComp > 0 ? 1 : 0}
  {collapsible}
  {expanded}
  {onExpandToggle}
>
  <div class="stepper">
    <button type="button" class="stepper-btn" aria-label="Decrease minimum compensation" onclick={() => step(-STEP)}>−</button>
    <label class="stepper-input-wrap">
      <span class="visually-hidden">Minimum compensation in USD</span>
      <input
        type="number"
        min="0"
        step={STEP}
        inputmode="numeric"
        placeholder="—"
        value={inputValue}
        oninput={(e) => { inputValue = (e.currentTarget as HTMLInputElement).value; }}
        onchange={(e) => commit((e.currentTarget as HTMLInputElement).value)}
        onblur={(e) => commit((e.currentTarget as HTMLInputElement).value)}
      />
      <span class="currency" aria-hidden="true">USD</span>
    </label>
    <button type="button" class="stepper-btn" aria-label="Increase minimum compensation" onclick={() => step(STEP)}>+</button>
  </div>
</GroupCard>

<style>
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

  .stepper {
    display: grid;
    grid-template-columns: var(--tap) 1fr var(--tap);
    gap: var(--space-1);
    align-items: stretch;
  }
  .stepper-btn {
    min-width: var(--tap);
    min-height: var(--tap);
    padding: 0;
    border: var(--rule-1) solid var(--color-rule-soft);
    border-radius: 0;
    background: transparent;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--text-3);
    cursor: pointer;
    transition: background-color 120ms ease-out, color 120ms ease-out;
  }
  .stepper-btn:hover { background: var(--color-ink); color: var(--color-paper); }
  .stepper-input-wrap {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0 var(--space-2);
    border: var(--rule-1) solid var(--color-rule-soft);
  }
  .stepper-input-wrap input {
    flex: 1 1 auto;
    min-height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    font-variant-numeric: tabular-nums;
  }
  .stepper-input-wrap input:focus-visible {
    outline: var(--rule-2) solid var(--color-accent);
    outline-offset: 2px;
  }
  .currency {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wider);
  }
</style>
