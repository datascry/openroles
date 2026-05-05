/**
 * Pure formatters for the editorial role-detail layout
 * (specs/uplift-v2-handoff.md §3). Used by the RoleDetail component to
 * produce the byline rule and the comp pullquote.
 */

import { atsShort } from "./ats-pretty.ts";

export interface RoleForFormat {
  readonly ats: string;
  readonly title: string;
  readonly company: string;
  readonly description_excerpt: string | null;
  readonly level: string | null;
  readonly workplace_type: string | null;
  readonly department: string | null;
  readonly location_text: string | null;
  readonly compensation_min: number | null;
  readonly compensation_max: number | null;
  readonly compensation_currency: string | null;
}

export interface BylinePart {
  /** Renderable value (already in display case, no further transformation). */
  readonly value: string;
}

/**
 * Compose the byline parts in display order: level · workplace · department
 * · location · comp · ats. Missing fields are dropped (the renderer joins
 * with `·` separators so empty parts produce no double-separator artifacts).
 */
export function bylineParts(role: RoleForFormat): ReadonlyArray<BylinePart> {
  const out: BylinePart[] = [];
  if (role.level) out.push({ value: role.level.toUpperCase() });
  if (role.workplace_type) {
    const wt = role.workplace_type.toUpperCase();
    // Suppress the parenthesised location when it would just duplicate the
    // workplace_type (e.g. workplace=remote + location_text="Remote" → just
    // render "REMOTE", not "REMOTE (REMOTE)").
    const loc = role.location_text;
    const dup = loc !== null && loc.trim().toUpperCase() === wt;
    out.push({ value: loc && !dup ? `${wt} (${loc})` : wt });
  } else if (role.location_text) {
    out.push({ value: role.location_text });
  }
  if (role.department) out.push({ value: role.department.toUpperCase() });
  const comp = formatCompShort(role);
  if (comp) out.push({ value: comp });
  out.push({ value: atsShort(role.ats) });
  return out;
}

/**
 * Returns the pullquote payload — the headline-style band displayed in the
 * body — or `null` when there is no comp data (spec §5.3: omit rather than
 * fall back to NLP-extracted benefit text).
 */
export function pullquote(role: RoleForFormat): { quote: string; sub: string } | null {
  const min = role.compensation_min;
  const max = role.compensation_max;
  if (min === null && max === null) return null;
  const cur = role.compensation_currency ?? "";
  const band = formatBand(min, max);
  const equity = mentionsEquity(role.description_excerpt);
  const quote = equity ? `${band} + EQUITY` : band;
  const subParts: string[] = ["Posted band"];
  if (cur) subParts.push(cur);
  if (role.location_text) subParts.push(role.location_text);
  return { quote, sub: subParts.join(" · ") };
}

function formatBand(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `${formatComp(min)} – ${formatComp(max)}`;
  if (min !== null) return `From ${formatComp(min)}`;
  if (max !== null) return `Up to ${formatComp(max)}`;
  return "";
}

function formatComp(n: number): string {
  if (n >= 1000) {
    const k = Math.round(n / 1000);
    return `$${k}K`;
  }
  return `$${n}`;
}

function formatCompShort(role: RoleForFormat): string | null {
  const min = role.compensation_min;
  const max = role.compensation_max;
  if (min === null && max === null) return null;
  return formatBand(min, max);
}

function mentionsEquity(excerpt: string | null): boolean {
  if (excerpt === null) return false;
  return /\bequity\b/i.test(excerpt);
}
