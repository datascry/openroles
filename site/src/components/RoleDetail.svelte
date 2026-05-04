<script lang="ts">
import { onMount } from "svelte";
import { loadClientDb } from "../lib/client-db.ts";
import { buildRoleByShortIdQuery, isShortId } from "../lib/role-detail-sql.ts";
import {
  loadApplied,
  loadIgnored,
  loadSaved,
  markApplied,
  toggleIgnored,
  toggleSaved,
  unmarkApplied,
} from "../lib/storage.ts";

// Client-rendered role detail. The static-prerender approach (one HTML
// file per job) didn't scale past ~50k jobs in the corpus — at the
// post-bootstrap 119k-tenant scale the site would emit 400k+ HTML files
// and blow both the 30-min CI build cap and the 1 GB GitHub Pages soft
// cap. The client-rendered route serves a single shell page and queries
// the SQLite at runtime via sql.js-httpvfs, the same path FilterTable
// uses for the index. See specs/role-detail.md (v3).
//
// Trade-off: no SEO. Per-role URLs are not pre-rendered, so neither
// Google for Jobs nor general crawlers can index individual postings.
// The index page (`/`) and per-tenant pages (`/tenant/<ats>/<slug>/`)
// remain statically rendered and discoverable.

interface Props {
  basePath: string;
}

interface Role {
  id: string;
  ats: string;
  tenant_slug: string;
  title: string;
  company: string;
  description_excerpt: string | null;
  level: string | null;
  workplace_type: string | null;
  is_recruiter_post: number;
  location_text: string | null;
  location_country: string | null;
  location_region: string | null;
  compensation_min: number | null;
  compensation_max: number | null;
  compensation_currency: string | null;
  department: string | null;
  posted_at: string | null;
  first_seen_at: string;
  is_stale: number;
  url: string;
}

const { basePath }: Props = $props();

const ATS_PRETTY: Record<string, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  bamboohr: "BambooHR",
  workday: "Workday",
  icims: "iCIMS",
  recruitee: "Recruitee",
  breezy: "Breezy",
  personio: "Personio",
  workable: "Workable",
  teamtailor: "Teamtailor",
  smartrecruiters: "SmartRecruiters",
  csod: "Cornerstone",
  taleo: "Taleo",
  ultipro: "UltiPro",
  jobvite: "Jobvite",
  zohorecruit: "Zoho Recruit",
  talentlyft: "TalentLyft",
  pinpointhq: "Pinpoint HQ",
  applicantpro: "ApplicantPro",
  applicantstack: "ApplicantStack",
  homerun: "Homerun",
  factorial: "Factorial",
  eightfold: "Eightfold",
};

let role: Role | null = $state(null);
let loadError: string | null = $state(null);
let loading = $state(true);
let saved = $state(false);
let applied = $state(false);
let ignored = $state(false);

function shortIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  // Prefer ?id=<short_id> query param (FilterTable links here).
  // Also accept /role/<short_id>/ legacy paths emitted by the prior
  // static prerender, surfaced by GitHub Pages 404s falling through
  // to /role/?id=... — operators copy-paste; we tolerate both.
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("id") ?? params.get("short_id");
  if (fromQuery && isShortId(fromQuery)) return fromQuery;
  const m = /\/role\/([0-9a-f]{16})\/?$/i.exec(window.location.pathname);
  if (m && m[1]) return m[1].toLowerCase();
  return null;
}

function refreshUserState(id: string): void {
  if (typeof window === "undefined") return;
  // Save / applied / ignored storage is keyed by the 16-char short_id
  // (storage.ts normalises everything to 16 chars on load — see the
  // 64-char-to-16-char migration comment there). The role-detail page
  // works with the full 64-char canonical Job.id, so normalise before
  // comparing or every includes() returns false and aria-pressed
  // never flips. Mirrors what FilterTable does for its row-level
  // save/applied/ignored buttons.
  const shortId = id.slice(0, 16);
  saved = loadSaved(window.localStorage).ids.includes(shortId);
  applied = loadApplied(window.localStorage).entries.some((e) => e.id === shortId);
  ignored = loadIgnored(window.localStorage).ids.includes(shortId);
}

onMount(async () => {
  const shortId = shortIdFromLocation();
  if (!shortId) {
    loadError = "No role id in URL. Open a role from the index page.";
    loading = false;
    return;
  }
  try {
    const db = await loadClientDb({ basePath });
    const plan = buildRoleByShortIdQuery(shortId);
    const rows = await db.query<Role>(plan.sql, plan.params);
    if (rows.length === 0) {
      loadError = "This role isn't in the current database. It may have expired or been removed.";
    } else {
      role = rows[0] ?? null;
      if (role) refreshUserState(role.id);
      // Update document title for share-link unfurls and browser tabs.
      if (role && typeof document !== "undefined") {
        document.title = `${role.title} at ${role.company} · openroles`;
      }
    }
  } catch (err) {
    loadError = `Couldn't load the role: ${err instanceof Error ? err.message : String(err)}`;
  }
  loading = false;
});

function onSave(): void {
  if (!role) return;
  toggleSaved(window.localStorage, role.id);
  refreshUserState(role.id);
}
function onApply(): void {
  if (!role) return;
  if (applied) {
    unmarkApplied(window.localStorage, role.id);
  } else {
    markApplied(window.localStorage, role.id, new Date().toISOString());
  }
  refreshUserState(role.id);
}
function onIgnore(): void {
  if (!role) return;
  toggleIgnored(window.localStorage, role.id);
  refreshUserState(role.id);
}

function relativeDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffDays = Math.floor((Date.now() - t) / 86_400_000);
  if (diffDays < 1) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays} days ago`;
  const months = Math.floor(diffDays / 30);
  if (months === 1) return "1 month ago";
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

function formatComp(r: Role): string | null {
  if (r.compensation_min === null && r.compensation_max === null) return null;
  const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);
  const cur = r.compensation_currency;
  if (r.compensation_min !== null && r.compensation_max !== null) {
    return `${fmt(r.compensation_min)} – ${fmt(r.compensation_max)}${cur ? ` ${cur}` : ""}`;
  }
  if (r.compensation_min !== null) return `from ${fmt(r.compensation_min)}${cur ? ` ${cur}` : ""}`;
  if (r.compensation_max !== null) return `up to ${fmt(r.compensation_max)}${cur ? ` ${cur}` : ""}`;
  return null;
}

function sourceHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
</script>

{#if loading}
  <p class="muted role-loading">Loading role…</p>
{:else if loadError}
  <div class="role-error">
    <p>{loadError}</p>
    <p><a href={`${basePath}/`}>← Back to all roles</a></p>
  </div>
{:else if role}
  <article class="role">
    <p class="back-link">
      <a href={`${basePath}/`}>← Back to all roles</a>
    </p>

    <header class="role-header">
      <h1>{role.title}</h1>
      <p class="role-meta">
        <a class="company" href={`${basePath}/tenant/${role.ats}/${role.tenant_slug}/`}>
          {role.company}
        </a>
        {#if role.department}<span class="dot" aria-hidden="true">·</span><span>{role.department}</span>{/if}
        {#if role.level}<span class="dot" aria-hidden="true">·</span><span class="cap">{role.level}</span>{/if}
        {#if role.workplace_type}<span class="dot" aria-hidden="true">·</span><span class="cap">{role.workplace_type}</span>{/if}
        {#if role.location_text}<span class="dot" aria-hidden="true">·</span><span>{role.location_text}</span>{/if}
      </p>
      {#if role.posted_at}
        <p class="role-dates muted">Posted {relativeDate(role.posted_at)}</p>
      {:else}
        <p class="role-dates muted">First seen {relativeDate(role.first_seen_at)}</p>
      {/if}
      {#if formatComp(role)}<p class="role-comp">{formatComp(role)}</p>{/if}
      {#if role.is_stale}
        <p class="stale-banner">
          This role was carried forward from a previous build — its source ATS may have stopped serving it.
        </p>
      {/if}
      {#if role.is_recruiter_post}
        <p class="muted recruiter-tag">Posted by an external recruiter / agency</p>
      {/if}
      <div class="role-cta">
        <a class="apply-cta" href={role.url} target="_blank" rel="noopener noreferrer">
          Apply on {ATS_PRETTY[role.ats] ?? role.ats} →
        </a>
        <div class="role-actions">
          <button type="button" onclick={onSave} aria-pressed={saved}>
            {saved ? "★ Saved" : "☆ Save"}
          </button>
          <button type="button" onclick={onApply} aria-pressed={applied}>
            {applied ? "✓ Applied" : "Mark applied"}
          </button>
          <button type="button" onclick={onIgnore} aria-pressed={ignored}>
            {ignored ? "⊘ Ignored" : "Ignore"}
          </button>
        </div>
      </div>
    </header>

    {#if role.description_excerpt}
      <section class="role-body">
        <h2>Description</h2>
        <p>{role.description_excerpt}</p>
      </section>
    {:else}
      <section class="role-body">
        <p class="muted">
          No description available from the source ATS. Open the apply link to view the full posting.
        </p>
      </section>
    {/if}

    <footer class="role-footer">
      <p class="muted">
        Apply on <strong>{ATS_PRETTY[role.ats] ?? role.ats}</strong> · Source: <code>{sourceHost(role.url)}</code>
      </p>
      <p class="muted small">
        This page is a filtered view of the original posting on the company's ATS. openroles does not host applications and adds no tracking parameters.
      </p>
    </footer>
  </article>
{/if}

<style>
  .role-loading { padding: var(--space-3); }
  .role-error { padding: var(--space-3); }
  .role { display: grid; gap: var(--space-3); max-inline-size: 65ch; margin-block-end: var(--space-5); }
  .back-link { margin: 0; }
  .role-header { display: grid; gap: var(--space-2); }
  h1 { font-size: var(--font-size-3); line-height: 1.15; margin: 0; }
  h2 { font-size: var(--font-size-2); margin-block-end: var(--space-1); }
  .role-meta { display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: baseline; margin: 0; }
  .company { font-weight: 600; }
  .dot { color: var(--color-muted); }
  .cap {
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
    font-size: var(--font-size-0);
  }
  .role-dates, .role-comp, .recruiter-tag { margin: 0; }
  .role-comp { font-variant-numeric: tabular-nums; }
  .stale-banner {
    background: var(--color-surface-2);
    border-inline-start: 3px solid var(--color-accent);
    padding: var(--space-2);
    margin: 0;
  }
  .role-cta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-block-start: var(--space-2);
  }
  .apply-cta { font-weight: 700; }
  .role-actions { display: flex; flex-wrap: wrap; gap: var(--space-1); }
  .role-actions button { cursor: pointer; }
  .role-body p { white-space: pre-wrap; }
  .role-footer { border-block-start: 1px solid var(--color-border); padding-block-start: var(--space-2); }
  .small { font-size: var(--font-size-0); }
  .muted { color: var(--color-muted); }
</style>
