<script lang="ts">
/**
 * Multi-select chip list with optional inline group-search and progressive
 * disclosure (specs/uplift-v2-handoff.md §2.5). Used by AtsGroup / LevelGroup /
 * WorkplaceGroup; not concerned with the group title or active count — that
 * lives in the parent.
 */
interface Option {
  readonly id: string;
  /** Display label; falls back to id when undefined. */
  readonly label?: string;
  /** Optional row count (announced to screen readers via aria-label). */
  readonly count?: number;
  /** When true the chip renders as disabled (no rows match given other filters). */
  readonly disabled?: boolean;
}

interface Props {
  options: ReadonlyArray<Option>;
  selected: ReadonlyArray<string>;
  onToggle: (id: string) => void;
  /** When set and options.length exceeds it, render an inline search input. */
  searchThreshold?: number;
  /** When options.length exceeds it, render a "Show all N" toggle. */
  showAllThreshold?: number;
  /** Programmatic label for the inline search input. */
  searchLabel?: string;
  /** Group-id used for input element ids; must be unique on the page. */
  groupId: string;
}

let {
  options,
  selected,
  onToggle,
  searchThreshold = Infinity,
  showAllThreshold = Infinity,
  searchLabel = "Filter list",
  groupId,
}: Props = $props();

let query = $state("");
let showAll = $state(false);

const showSearch = $derived(options.length > searchThreshold);
const canShowAll = $derived(options.length > showAllThreshold);

const filtered = $derived(
  query.trim().length === 0
    ? options
    : options.filter((o) => (o.label ?? o.id).toLowerCase().includes(query.trim().toLowerCase())),
);

const visibleOptions = $derived(
  canShowAll && !showAll ? filtered.slice(0, showAllThreshold) : filtered,
);
const hiddenCount = $derived(
  canShowAll && !showAll ? Math.max(0, filtered.length - showAllThreshold) : 0,
);
</script>

{#if showSearch}
  <label class="visually-hidden" for={`${groupId}-search`}>{searchLabel}</label>
  <input
    id={`${groupId}-search`}
    class="group-search"
    type="search"
    placeholder="Filter…"
    value={query}
    oninput={(e) => { query = (e.currentTarget as HTMLInputElement).value; }}
  />
{/if}

<div class="chip-list" role="group">
  {#each visibleOptions as opt (opt.id)}
    {@const isOn = selected.includes(opt.id)}
    {@const label = opt.label ?? opt.id}
    {@const ariaLabel = opt.count !== undefined ? `${label}, ${opt.count} roles` : label}
    <button
      type="button"
      class="chip"
      class:is-active={isOn}
      class:is-disabled={opt.disabled}
      aria-pressed={isOn}
      aria-label={ariaLabel}
      title={opt.disabled ? "0 roles match this combination." : undefined}
      disabled={opt.disabled}
      onclick={() => onToggle(opt.id)}
    >
      <span class="chip-label">{label}</span>
      {#if opt.count !== undefined}<span class="chip-count" aria-hidden="true">{opt.count}</span>{/if}
      {#if isOn}<span class="chip-x" aria-hidden="true">×</span>{/if}
    </button>
  {/each}
  {#if filtered.length === 0 && query.length > 0}
    <p class="no-match" aria-live="polite">No match</p>
  {/if}
</div>

{#if hiddenCount > 0}
  <button type="button" class="show-all" onclick={() => { showAll = true; }}>
    Show all {filtered.length}
  </button>
{:else if canShowAll && showAll && filtered.length > showAllThreshold}
  <button type="button" class="show-all" onclick={() => { showAll = false; }}>
    Show fewer
  </button>
{/if}

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

  .group-search {
    width: 100%;
    min-height: 32px;
    padding: 0 var(--space-2);
    border: var(--rule-1) solid var(--color-rule-soft);
    border-radius: 0;
    background: transparent;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    margin-block-end: var(--space-2);
  }

  .chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
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
  .chip:hover:not(:disabled) {
    border-color: var(--color-ink);
    color: var(--color-ink);
  }
  .chip.is-active {
    background: var(--color-ink);
    border-color: var(--color-ink);
    color: var(--color-paper);
  }
  .chip.is-active .chip-x {
    color: var(--color-accent);
    font-size: var(--text-2);
    line-height: 1;
  }
  .chip.is-disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .chip-count {
    font-size: var(--text-00);
    color: var(--color-ink-3);
  }
  .chip.is-active .chip-count { color: var(--color-paper); }

  .no-match {
    margin: var(--space-2) 0 0;
    color: var(--color-ink-3);
    font-family: var(--font-serif);
    font-size: var(--text-1);
    font-style: italic;
  }

  .show-all {
    margin-block-start: var(--space-2);
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    text-transform: uppercase;
    letter-spacing: var(--track-wider);
    cursor: pointer;
    min-height: var(--tap);
  }
  .show-all:hover { text-decoration: underline; text-underline-offset: 0.15em; }
</style>
