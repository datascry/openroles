<script lang="ts">
import { ATS_IDS, type ATSId } from "@openroles/shared/constants";
import type { FilterState } from "../../lib/filter-state.ts";
import ChipList from "./ChipList.svelte";
import GroupCard from "./GroupCard.svelte";

interface Props {
  filters: Pick<FilterState, "ats">;
  onPatch: (patch: Partial<FilterState>) => void;
  counts?: Record<string, number>;
  collapsible?: boolean;
  expanded?: boolean;
  onExpandToggle?: (expanded: boolean) => void;
}

let { filters, onPatch, counts, collapsible, expanded, onExpandToggle }: Props = $props();

const options = $derived(
  ATS_IDS.map((id) => {
    const count = counts?.[id];
    const effective = count ?? 0;
    return {
      id,
      label: id,
      count,
      // Don't disable an already-active chip — the user must always be able
      // to toggle it back off. Otherwise an absent / zero count means no
      // match for the current other-filter set.
      disabled: counts !== undefined && effective === 0 && !filters.ats.includes(id),
    };
  }),
);

function toggle(id: string) {
  const ats = filters.ats as ReadonlyArray<ATSId>;
  const next = ats.includes(id as ATSId) ? ats.filter((x) => x !== id) : [...ats, id as ATSId];
  onPatch({ ats: next });
}
</script>

<GroupCard
  id="ats"
  title={`ATS · ${filters.ats.length}/${ATS_IDS.length}`}
  count={filters.ats.length}
  {collapsible}
  {expanded}
  {onExpandToggle}
>
  <ChipList
    groupId="ats"
    options={options}
    selected={filters.ats}
    onToggle={toggle}
    searchThreshold={8}
    showAllThreshold={6}
    searchLabel="Filter ATS list"
  />
</GroupCard>
