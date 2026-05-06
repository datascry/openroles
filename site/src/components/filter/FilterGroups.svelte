<script lang="ts">
import { onMount } from "svelte";
import type { FilterState } from "../../lib/filter-state.ts";
import { loadGroupExpansion, saveGroupExpansion } from "../../lib/group-storage.ts";
import AtsGroup from "./AtsGroup.svelte";
import LevelGroup from "./LevelGroup.svelte";
import MinCompGroup from "./MinCompGroup.svelte";
import PersonalToggles from "./PersonalToggles.svelte";
import PostedGroup from "./PostedGroup.svelte";
import StatusToggles from "./StatusToggles.svelte";
import WorkplaceGroup from "./WorkplaceGroup.svelte";

// ATS sits at the bottom of the sidebar and starts collapsed by default.
// Most job seekers don't filter by which hiring platform hosts a role,
// so it's de-emphasized — but power users (e.g. people avoiding a
// specific ATS for accessibility / process reasons) can still reach it
// in one click without leaving the sidebar.

/**
 * Renders every filter group in vertical sequence. Used by both the desktop
 * sidebar and the mobile sheet — the chrome differs (collapsible vs always-
 * open headers) but the group sequence is identical.
 */
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
  /** Whether each group title doubles as a collapse toggle (mobile only). */
  collapsible?: boolean;
}

let {
  filters,
  onPatch,
  savedCount,
  appliedCount,
  ignoredCount,
  optionCounts,
  collapsible = false,
}: Props = $props();

const GROUP_IDS = ["wt", "posted", "level", "minComp", "status", "personal", "ats"] as const;
type GroupId = (typeof GROUP_IDS)[number];

// Default policy reflects user-stated priorities (workplace + posted are
// the two filters first-time visitors reach for). ATS sits last and
// starts collapsed — see file-top comment. Per-user expansion
// preferences are restored from localStorage onMount; first-visit users
// see these defaults. Personal auto-expands below if the user has any
// saved/applied/ignored roles (return-visitor signal).
let expansion = $state<Record<GroupId, boolean>>({
  wt: true,
  posted: true,
  level: false,
  minComp: false,
  status: false,
  personal: false,
  ats: false,
});

// Hydrate persisted expansion state once on mount. A reactive $effect would
// loop because the body reads and writes `expansion`.
onMount(() => {
  if (!collapsible) return;
  if (typeof window === "undefined") return;
  const next = { ...expansion };
  for (const id of GROUP_IDS) {
    const stored = loadGroupExpansion(window.localStorage, id);
    if (stored !== undefined) next[id] = stored;
  }
  // Personal auto-expand: if the user has any saved/applied/ignored roles
  // AND they haven't explicitly collapsed the section before, surface it
  // open so the entry points to those collections are one click away.
  // First-time visitors with empty collections see it collapsed.
  const hasPersonalContent = savedCount + appliedCount + ignoredCount > 0;
  if (hasPersonalContent && loadGroupExpansion(window.localStorage, "personal") === undefined) {
    next.personal = true;
  }
  expansion = next;
});

function setExpansion(id: GroupId, value: boolean) {
  expansion = { ...expansion, [id]: value };
  if (collapsible && typeof window !== "undefined") {
    saveGroupExpansion(window.localStorage, id, value);
  }
}
</script>

<div class="groups">
  <!-- Workplace + Posted are the two facets first-time visitors reach
       for, so they sit at the top and start open. Level follows because
       it's the next most-used; collapsed by default to keep the sidebar
       short. ATS is removed from the sidebar entirely. -->
  <WorkplaceGroup
    filters={filters}
    onPatch={onPatch}
    counts={optionCounts?.wt}
    collapsible={collapsible}
    expanded={expansion.wt}
    onExpandToggle={(v) => setExpansion("wt", v)}
  />
  <PostedGroup
    filters={filters}
    onPatch={onPatch}
    collapsible={collapsible}
    expanded={expansion.posted}
    onExpandToggle={(v) => setExpansion("posted", v)}
  />
  <LevelGroup
    filters={filters}
    onPatch={onPatch}
    counts={optionCounts?.level}
    collapsible={collapsible}
    expanded={expansion.level}
    onExpandToggle={(v) => setExpansion("level", v)}
  />
  <MinCompGroup
    filters={filters}
    onPatch={onPatch}
    collapsible={collapsible}
    expanded={expansion.minComp}
    onExpandToggle={(v) => setExpansion("minComp", v)}
  />
  <StatusToggles
    filters={filters}
    onPatch={onPatch}
    collapsible={collapsible}
    expanded={expansion.status}
    onExpandToggle={(v) => setExpansion("status", v)}
  />
  <PersonalToggles
    filters={filters}
    onPatch={onPatch}
    savedCount={savedCount}
    appliedCount={appliedCount}
    ignoredCount={ignoredCount}
    collapsible={collapsible}
    expanded={expansion.personal}
    onExpandToggle={(v) => setExpansion("personal", v)}
  />
  <!-- ATS is the bottom-most section and starts collapsed. Surfaces
       the long list of hiring platforms for users who specifically
       want to include / exclude one without dominating the sidebar. -->
  <AtsGroup
    filters={filters}
    onPatch={onPatch}
    counts={optionCounts?.ats}
    collapsible={collapsible}
    expanded={expansion.ats}
    onExpandToggle={(v) => setExpansion("ats", v)}
  />
</div>

<style>
  .groups {
    display: grid;
    gap: var(--space-4);
  }
</style>
