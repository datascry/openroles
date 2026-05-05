<script lang="ts">
import type { Snippet } from "svelte";

/**
 * Shared chrome for a sidebar / sheet filter group: title + active count,
 * with optional collapse toggle on mobile (specs/uplift-v2-handoff.md §2.5).
 */
interface Props {
  id: string;
  title: string;
  count: number;
  /** When true the title doubles as a collapse/expand toggle (mobile only). */
  collapsible?: boolean;
  expanded?: boolean;
  onExpandToggle?: (expanded: boolean) => void;
  children: Snippet;
}

let {
  id,
  title,
  count,
  collapsible = false,
  expanded = true,
  onExpandToggle,
  children,
}: Props = $props();

const headerId = `${id}-header`;
const bodyId = `${id}-body`;

function onToggle() {
  if (!collapsible) return;
  const next = !expanded;
  onExpandToggle?.(next);
}
</script>

<section class="group" aria-labelledby={headerId}>
  {#if collapsible}
    <button
      type="button"
      class="group-header group-header-button"
      id={headerId}
      aria-expanded={expanded}
      aria-controls={bodyId}
      onclick={onToggle}
    >
      <span class="title">{title}</span>
      {#if count > 0}
        <span class="count">{count}</span>
      {/if}
      <span class="chev" aria-hidden="true">{expanded ? "−" : "+"}</span>
    </button>
  {:else}
    <h3 class="group-header" id={headerId}>
      <span class="title">{title}</span>
      {#if count > 0}
        <span class="count">{count}</span>
      {/if}
    </h3>
  {/if}
  {#if expanded}
    <div class="group-body" id={bodyId} role="group" aria-labelledby={headerId}>
      {@render children()}
    </div>
  {/if}
</section>

<style>
  .group {
    display: grid;
    gap: var(--space-2);
  }

  .group-header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    padding-block-end: var(--space-1);
    border-bottom: var(--rule-2) solid var(--color-ink);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .group-header.group-header-button {
    appearance: none;
    background: transparent;
    border: 0;
    border-bottom: var(--rule-2) solid var(--color-ink);
    width: 100%;
    text-align: left;
    cursor: pointer;
    min-height: var(--tap);
  }
  .title { flex: 0 0 auto; }
  .count {
    margin-inline-start: auto;
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    font-weight: 700;
  }
  .group-header-button .chev {
    margin-inline-start: var(--space-2);
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-2);
    line-height: 1;
  }
</style>
