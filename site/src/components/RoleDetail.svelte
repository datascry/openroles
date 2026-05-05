<script lang="ts">
import { onMount } from "svelte";
import { atsLong } from "../lib/ats-pretty.ts";
import { loadClientDb } from "../lib/client-db.ts";
import { bylineParts, pullquote, type RoleForFormat } from "../lib/role-detail-format.ts";
import {
  bodyParas,
  dropcap,
  freshnessTag,
  relativeDays,
  shortDate,
  shortIdFromUrl,
  strapText,
} from "../lib/role-detail-helpers.ts";
import { buildRoleByShortIdQuery } from "../lib/role-detail-sql.ts";
import { buildRelatedRolesCountQuery, buildRelatedRolesQuery } from "../lib/role-related-sql.ts";
import {
  loadApplied,
  loadIgnored,
  loadSaved,
  markApplied,
  toggleIgnored,
  toggleSaved,
  unmarkApplied,
} from "../lib/storage.ts";

// Editorial broadsheet layout for the role-detail page
// (specs/uplift-v2-handoff.md §3, specs/role-detail.md v3.1).

interface Props {
  basePath: string;
}

interface Role extends RoleForFormat {
  id: string;
  tenant_slug: string;
  is_recruiter_post: number;
  location_country: string | null;
  location_region: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  is_stale: number;
  url: string;
}

interface RelatedRole {
  id: string;
  ats: string;
  tenant_slug: string;
  title: string;
  posted_at: string | null;
  first_seen_at: string;
  level: string | null;
  workplace_type: string | null;
}

const { basePath }: Props = $props();

let role: Role | null = $state(null);
let loadError: string | null = $state(null);
let loading = $state(true);
let saved = $state(false);
let applied = $state(false);
let ignored = $state(false);
let relatedRoles: ReadonlyArray<RelatedRole> = $state([]);
let relatedTotal = $state(0);
let stickyApply = $state(false);
let inflowCardEl: HTMLElement | null = $state(null);

const FACT_LABELS: ReadonlyArray<{ key: keyof Role | "comp"; label: string }> = [
  { key: "company", label: "Company" },
  { key: "title", label: "Title" },
  { key: "level", label: "Level" },
  { key: "workplace_type", label: "Workplace" },
  { key: "location_text", label: "Location" },
  { key: "comp", label: "Comp" },
  { key: "department", label: "Department" },
  { key: "posted_at", label: "Posted" },
  { key: "first_seen_at", label: "First seen" },
  { key: "ats", label: "ATS" },
];

function shortIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return shortIdFromUrl(window.location.search, window.location.pathname);
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
      if (role) {
        refreshUserState(role.id);
        if (typeof document !== "undefined") {
          document.title = `${role.title} at ${role.company} · openroles`;
        }
        // Fire the related-roles query in parallel; tolerate a failure.
        try {
          const relPlan = buildRelatedRolesQuery(role.tenant_slug, role.id, 4);
          const countPlan = buildRelatedRolesCountQuery(role.tenant_slug, role.id);
          const [relRows, countRows] = await Promise.all([
            db.query<RelatedRole>(relPlan.sql, relPlan.params),
            db.query<{ c: number }>(countPlan.sql, countPlan.params),
          ]);
          relatedRoles = relRows;
          relatedTotal = countRows[0]?.c ?? 0;
        } catch {
          relatedRoles = [];
          relatedTotal = 0;
        }
      }
    }
  } catch (err) {
    loadError = `Couldn't load the role: ${err instanceof Error ? err.message : String(err)}`;
  }
  loading = false;
});

onMount(() => {
  if (typeof window === "undefined") return;
  // Sticky-apply is mobile-only (the sticky bar is `display: none` past
  // --bp-sidebar). Skip the listener on desktop so we don't burn frames.
  const desktopMq = window.matchMedia(`(min-width: 800px)`);
  if (desktopMq.matches) return;
  // IntersectionObserver fires when the in-flow card's bottom edge crosses
  // the top of the viewport — much cheaper than scroll-listening with
  // getBoundingClientRect() on every frame.
  let observer: IntersectionObserver | null = null;
  function attach() {
    if (observer) observer.disconnect();
    if (!inflowCardEl) return;
    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        // Sticky should appear once the card is fully scrolled out of view
        // upward (intersectionRatio === 0 AND boundingClientRect.bottom < 0).
        const rect = entry.boundingClientRect;
        stickyApply = !entry.isIntersecting && rect.bottom < 0;
      },
      { threshold: 0 },
    );
    observer.observe(inflowCardEl);
  }
  // First attach on next tick so the bind:this has resolved.
  queueMicrotask(attach);
  // Re-attach if the card mounts later (loading completes, etc.).
  const interval = setInterval(() => {
    if (!observer && inflowCardEl) attach();
  }, 250);
  return () => {
    clearInterval(interval);
    observer?.disconnect();
  };
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

function factValue(r: Role, key: (typeof FACT_LABELS)[number]["key"]): string | null {
  if (key === "comp") {
    if (r.compensation_min === null && r.compensation_max === null) return null;
    const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);
    const cur = r.compensation_currency;
    if (r.compensation_min !== null && r.compensation_max !== null) {
      return `${fmt(r.compensation_min)} – ${fmt(r.compensation_max)}${cur ? ` ${cur}` : ""}`;
    }
    if (r.compensation_min !== null)
      return `from ${fmt(r.compensation_min)}${cur ? ` ${cur}` : ""}`;
    if (r.compensation_max !== null)
      return `up to ${fmt(r.compensation_max)}${cur ? ` ${cur}` : ""}`;
    return null;
  }
  if (key === "posted_at") return relativeDays(r.posted_at);
  if (key === "first_seen_at") return relativeDays(r.first_seen_at);
  if (key === "ats") return atsLong(r.ats);
  if (key === "workplace_type" && r.workplace_type) return r.workplace_type.toUpperCase();
  if (key === "level" && r.level) return r.level.toUpperCase();
  const v = r[key];
  if (v === null || v === undefined) return null;
  return String(v);
}
</script>

<!-- Cross-fade: skeleton fades out as content fades in (spec §3.8). Using
     opacity-only transitions keeps the layout stable so there's no jump,
     and the project-wide `prefers-reduced-motion` override clamps the
     duration to 0.01 ms so users who opt out get an instant switch. -->
{#if loading}
  <article
    class="role-skeleton fade"
    class:fade-in={loading}
    role="progressbar"
    aria-busy="true"
    aria-label="Loading role"
  >
    <div class="sk-line sk-kicker"></div>
    <div class="sk-line sk-headline"></div>
    <div class="sk-line sk-headline"></div>
    <div class="sk-line sk-strap"></div>
    <div class="sk-byline"></div>
    {#each [1, 2, 3, 4, 5, 6, 7, 8] as _, i (i)}
      <div class="sk-line sk-body"></div>
    {/each}
  </article>
{:else if loadError}
  <article class="role-error">
    <p class="back-rail">
      <a href={`${basePath}/`} class="back-link">← All roles</a>
    </p>
    <p class="kicker">openroles</p>
    <h1 class="headline">Role not found</h1>
    <p class="strap">{loadError}</p>
    <p>
      <a href={`${basePath}/`} class="back-cta">← Back to all roles</a>
    </p>
  </article>
{:else if role}
  {@const tag = freshnessTag(role.posted_at, role.first_seen_at, {
    isStale: role.is_stale === 1,
    lastSeenAt: role.last_seen_at,
  })}
  {@const pull = pullquote(role)}
  {@const parts = bylineParts(role)}
  {@const paragraphs = bodyParas(role.description_excerpt)}
  {@const strap = strapText(role.description_excerpt)}

  <article class="role fade fade-in">
    <div class="rail-top">
      <a href={`${basePath}/`} class="back-link">← All roles</a>
      <span class={`fresh-tag fresh-tag--${tag.tone}`}>{tag.text}</span>
    </div>

    <header class="role-head">
      <a class="kicker" href={`${basePath}/tenant/${role.ats}/${role.tenant_slug}/`}>
        {role.company}
      </a>
      <h1 class="headline">{role.title}</h1>
      {#if strap}<p class="strap">{strap}</p>{/if}
    </header>

    <ul role="list" class="byline" aria-label="Role facts">
      {#each parts as part, i (i)}
        <li class="byline-item">
          <strong>{part.value}</strong>
        </li>
      {/each}
    </ul>

    {#if role.is_recruiter_post}
      <p class="recruiter-line">Posted by an external recruiter</p>
    {/if}

    {#if role.is_stale}
      <p class="stale-banner">
        This role was last seen in our database on {shortDate(role.first_seen_at)}.
        {role.company} may have removed the original posting.
      </p>
    {/if}

    <div class="body-grid">
      <main class="body">
        <!-- Mobile-only in-flow apply card; on desktop the right rail handles it.
             When sticky bar is visible, hide this from the a11y tree to avoid
             duplicate Apply tab stops (spec §3.9). -->
        <aside
          class="apply-card apply-card--inflow"
          aria-hidden={stickyApply}
          inert={stickyApply}
          bind:this={inflowCardEl}
        >
          <a
            class="apply-cta"
            href={role.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Apply for ${role.title} at ${role.company} on ${atsLong(role.ats)} (opens in a new tab)`}
          >
            Apply on {atsLong(role.ats)} →
          </a>
          <div class="apply-actions">
            <button type="button" class="action" aria-pressed={saved} onclick={onSave}>
              {saved ? "★ Saved" : "☆ Save"}
            </button>
            <button type="button" class="action" aria-pressed={applied} onclick={onApply}>
              {applied ? "✓ Applied" : "Mark applied"}
            </button>
            <button type="button" class="action" aria-pressed={ignored} onclick={onIgnore}>
              {ignored ? "⊘ Ignored" : "Ignore"}
            </button>
          </div>
        </aside>

        {#if paragraphs.length === 0}
          <p class="no-description">
            No description available from the source ATS. Open the apply link to read the full
            posting on {atsLong(role.ats)}.
          </p>
        {:else}
          {#each paragraphs as para, i (i)}
            {#if i === 0}
              {@const dc = dropcap(para)}
              <p class="body-para body-para--first">
                <span class="dropcap" aria-hidden="true">{dc.first}</span>{dc.rest}
              </p>
            {:else}
              <p class="body-para">{para}</p>
            {/if}
          {/each}
        {/if}

        {#if pull}
          <blockquote class="pullquote">
            <span class="pullquote-q">"{pull.quote}"</span>
            <cite class="pullquote-sub">— {pull.sub}</cite>
          </blockquote>
        {/if}

        <p class="local-state-disclosure">
          Saved / applied / ignored states are stored in this browser only — they do not sync
          across devices and we don't see them on the server.
        </p>
      </main>

      <aside class="rail">
        <div class="apply-card apply-card--rail">
          <a
            class="apply-cta"
            href={role.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Apply for ${role.title} at ${role.company} on ${atsLong(role.ats)} (opens in a new tab)`}
          >
            Apply on {atsLong(role.ats)} →
          </a>
          <div class="apply-actions">
            <button type="button" class="action" aria-pressed={saved} onclick={onSave}>
              {saved ? "★ Saved" : "☆ Save"}
            </button>
            <button type="button" class="action" aria-pressed={applied} onclick={onApply}>
              {applied ? "✓ Applied" : "Mark applied"}
            </button>
            <button type="button" class="action" aria-pressed={ignored} onclick={onIgnore}>
              {ignored ? "⊘ Ignored" : "Ignore"}
            </button>
          </div>
        </div>

        <section class="fact-card" aria-labelledby="facts-h">
          <h3 id="facts-h" class="fact-h">The facts</h3>
          <dl class="facts">
            {#each FACT_LABELS as f (f.key)}
              {@const value = factValue(role, f.key)}
              <div class="fact-row">
                <dt>{f.label}</dt>
                <dd class:fact-accent={f.key === "level"}>
                  {#if value === null}
                    <em class="not-stated">not stated</em>
                  {:else}
                    {value}
                  {/if}
                </dd>
              </div>
            {/each}
          </dl>
        </section>

        {#if relatedRoles.length > 0}
          <section class="more-card" aria-labelledby="more-h">
            <h3 id="more-h" class="more-h">More from {role.company}</h3>
            <ul role="list" class="more-list">
              {#each relatedRoles as r (r.id)}
                <li>
                  <a
                    href={`${basePath}/role/?id=${r.id.slice(0, 16)}`}
                    aria-label={`${r.title} at ${role.company}`}
                  >{r.title}</a>
                </li>
              {/each}
            </ul>
            {#if relatedTotal > relatedRoles.length}
              <a
                href={`${basePath}/tenant/${role.ats}/${role.tenant_slug}/`}
                class="more-all"
              >All {relatedTotal} {role.company} roles →</a>
            {/if}
          </section>
        {/if}
      </aside>
    </div>

    <!-- Continuously-mounted sticky-apply so the slide-in/out animation
         actually plays (spec §3.8). Visibility is class-driven; the a11y
         tree hides it when not visible. -->
    <div
      class="sticky-apply"
      class:is-visible={stickyApply}
      aria-hidden={!stickyApply}
      inert={!stickyApply}
    >
      <a
        class="apply-cta"
        href={role.url}
        target="_blank"
        rel="noopener noreferrer"
        tabindex={stickyApply ? 0 : -1}
      >Apply on {atsLong(role.ats)} →</a>
    </div>
  </article>
{/if}

<style>
  /* ---------- Cross-fade between skeleton and content (spec §3.8) ---------- */
  .fade {
    opacity: 0;
    transition: opacity 180ms ease-out;
  }
  .fade.fade-in {
    opacity: 1;
  }

  /* ---------- Skeleton ---------- */
  .role-skeleton {
    display: grid;
    gap: var(--space-3);
    max-inline-size: 78rem;
    margin-block-end: var(--space-7);
  }
  .sk-line {
    background: var(--color-rule-soft);
    height: 1em;
    width: 100%;
  }
  .sk-kicker { width: 8rem; height: var(--text-1); }
  .sk-headline { height: var(--text-6); }
  .sk-strap { width: 70%; height: var(--text-3); margin-block-start: var(--space-3); }
  .sk-byline {
    border-top: var(--rule-2) solid var(--color-ink);
    border-bottom: var(--rule-2) solid var(--color-ink);
    height: var(--text-2);
    margin-block: var(--space-4);
  }
  .sk-body { height: var(--text-2); }

  /* ---------- Error ---------- */
  .role-error {
    display: grid;
    gap: var(--space-3);
    max-inline-size: 60ch;
    padding-block: var(--space-7);
  }
  .role-error .headline {
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-5);
    font-weight: 900;
    letter-spacing: var(--track-tight);
    text-transform: uppercase;
    margin: 0;
  }
  .role-error .strap {
    color: var(--color-ink-2);
    font-family: var(--font-serif);
    font-size: var(--text-3);
    font-style: italic;
  }
  .back-cta {
    color: var(--color-accent);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
  }

  /* ---------- Role article ---------- */
  .role {
    display: grid;
    gap: var(--space-5);
    max-inline-size: 78rem;
    padding-block-end: var(--space-9);
  }

  .rail-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding-block: var(--space-2);
    border-bottom: var(--rule-1) solid var(--color-rule);
  }
  .back-link {
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
    text-decoration: none;
  }
  .back-link:hover { color: var(--color-accent); }
  .fresh-tag {
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
    color: var(--color-ink-3);
  }
  .fresh-tag--fresh { color: var(--color-accent); }
  .fresh-tag--active { color: var(--color-ink); }

  .role-head { display: grid; gap: var(--space-3); }
  .kicker {
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    font-weight: 700;
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
    text-decoration: none;
    justify-self: start;
  }
  .kicker:hover { text-decoration: underline; text-underline-offset: 0.15em; }
  .headline {
    margin: 0;
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-7);
    font-weight: 900;
    letter-spacing: var(--track-tight);
    line-height: 0.92;
    text-transform: uppercase;
    /* `INFRASTRUCTURE` at 48 px is ~390 px wide — wider than a 375 px
     * mobile viewport. Break within long words rather than overflow the
     * page horizontally; spec §3.7.a allows multi-line growth. */
    overflow-wrap: anywhere;
    word-break: break-word;
    hyphens: auto;
  }
  .strap {
    margin: 0;
    color: var(--color-ink-2);
    font-family: var(--font-serif);
    font-size: var(--text-4);
    font-style: italic;
    max-inline-size: 60ch;
  }

  .byline {
    list-style: none;
    margin: 0;
    border-top: var(--rule-2) solid var(--color-ink);
    border-bottom: var(--rule-2) solid var(--color-ink);
    padding: var(--space-2) 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
    color: var(--color-ink-2);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .byline-item {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
  }
  .byline-item:not(:first-child)::before {
    content: "·";
    color: var(--color-ink-3);
  }
  .byline-item strong { color: var(--color-ink); font-weight: 700; }

  .recruiter-line {
    margin: 0;
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }

  .stale-banner {
    margin: 0;
    background: var(--color-accent-soft);
    border-inline-start: var(--rule-4) solid var(--color-accent);
    padding: var(--space-2) var(--space-3);
    color: var(--color-ink-2);
    font-family: var(--font-serif);
    font-size: var(--text-2);
    font-style: italic;
  }

  /* ---------- Body grid ---------- */
  .body-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-5);
  }
  @media (min-width: 800px) {
    .body-grid {
      grid-template-columns: minmax(0, 1fr) 280px;
      gap: var(--space-7);
    }
  }

  .body { display: grid; gap: var(--space-3); }
  .body-para {
    margin: 0;
    color: var(--color-ink-2);
    font-family: var(--font-serif);
    font-size: var(--text-3);
    line-height: 1.65;
    white-space: pre-wrap;
  }
  .body-para--first .dropcap {
    float: left;
    color: var(--color-accent);
    font-family: var(--font-display);
    font-weight: 900;
    font-size: 4rem;
    line-height: 0.85;
    padding-inline-end: var(--space-2);
    text-transform: uppercase;
  }

  .pullquote {
    margin: var(--space-4) 0;
    padding-block: var(--space-3);
    border-top: var(--rule-2) solid var(--color-ink);
    border-bottom: var(--rule-2) solid var(--color-ink);
    display: grid;
    gap: var(--space-2);
  }
  .pullquote-q {
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-5);
    font-weight: 800;
    letter-spacing: var(--track-tight);
    line-height: 1.05;
    text-transform: uppercase;
  }
  .pullquote-sub {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
    font-style: normal;
  }

  .no-description {
    margin: 0;
    color: var(--color-ink-3);
    font-family: var(--font-serif);
    font-size: var(--text-3);
    font-style: italic;
  }

  .local-state-disclosure {
    margin-block-start: var(--space-5);
    padding: var(--space-2) var(--space-3);
    border-top: var(--rule-1) dashed var(--color-rule);
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-1);
  }

  /* ---------- Right rail ---------- */
  .rail { display: grid; gap: var(--space-4); align-self: start; }
  @media (min-width: 800px) {
    .rail { position: sticky; top: var(--space-3); }
  }

  .apply-card {
    border: var(--rule-2) solid var(--color-ink);
    padding: var(--space-3);
    display: grid;
    gap: var(--space-3);
    background: var(--color-paper);
  }
  .apply-card--inflow { display: grid; }
  .apply-card--rail { display: none; }
  @media (min-width: 800px) {
    .apply-card--inflow { display: none; }
    .apply-card--rail { display: grid; }
  }
  .apply-cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 64px;
    padding: var(--space-3);
    background: var(--color-accent);
    color: var(--color-on-accent);
    border: var(--rule-1) solid var(--color-accent);
    font-family: var(--font-display);
    font-size: var(--text-3);
    font-weight: 800;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    text-decoration: none;
    transition: background-color 120ms ease-out, color 120ms ease-out;
  }
  .apply-cta:hover {
    background: var(--color-ink);
    border-color: var(--color-ink);
    color: var(--color-paper);
  }
  .apply-actions {
    display: flex;
    gap: var(--space-1);
  }
  .action {
    flex: 1 1 0;
    appearance: none;
    border: var(--rule-1) solid var(--color-ink);
    border-radius: 0;
    background: var(--color-paper);
    color: var(--color-ink);
    min-height: var(--tap);
    padding: 0 var(--space-2);
    font-family: var(--font-display);
    font-size: var(--text-0);
    font-weight: 700;
    letter-spacing: var(--track-wide);
    text-transform: uppercase;
    cursor: pointer;
    transition: background-color 120ms ease-out, color 120ms ease-out;
  }
  .action[aria-pressed="true"],
  .action:hover {
    background: var(--color-ink);
    color: var(--color-paper);
  }

  .fact-card {
    border: var(--rule-2) solid var(--color-ink);
    padding: var(--space-3);
    background: var(--color-paper);
  }
  .fact-h {
    margin: 0 0 var(--space-2);
    padding-block-end: var(--space-1);
    border-bottom: var(--rule-1) solid var(--color-ink);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 800;
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .facts { margin: 0; padding: 0; display: grid; }
  .fact-row {
    display: grid;
    grid-template-columns: 90px 1fr;
    padding-block: 6px;
    border-bottom: var(--rule-1) dashed var(--color-rule-soft);
    gap: var(--space-2);
  }
  .fact-row:last-child { border-bottom: 0; }
  .fact-row dt {
    margin: 0;
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .fact-row dd {
    margin: 0;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--text-1);
    font-weight: 600;
    text-transform: uppercase;
    word-break: break-word;
  }
  .fact-row dd.fact-accent { color: var(--color-accent); }
  .not-stated {
    color: var(--color-ink-3);
    font-style: italic;
    font-weight: 400;
    text-transform: none;
  }

  .more-card {
    border: var(--rule-2) solid var(--color-ink);
    padding: var(--space-3);
    background: var(--color-paper);
  }
  .more-h {
    margin: 0 0 var(--space-2);
    padding-block-end: var(--space-1);
    border-bottom: var(--rule-1) solid var(--color-ink);
    color: var(--color-ink);
    font-family: var(--font-display);
    font-size: var(--text-1);
    font-weight: 800;
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }
  .more-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-1);
  }
  .more-list a {
    color: var(--color-ink-2);
    font-family: var(--font-serif);
    font-size: var(--text-2);
    text-decoration: none;
    line-height: 1.3;
  }
  .more-list a:hover { color: var(--color-accent); text-decoration: underline; text-underline-offset: 0.15em; }
  .more-all {
    display: inline-block;
    margin-block-start: var(--space-2);
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: var(--text-0);
    letter-spacing: var(--track-wider);
    text-transform: uppercase;
  }

  /* ---------- Sticky mobile apply ----------
   * Continuously mounted; class toggle drives the slide-in/out animation
   * (spec §3.8 — 180 ms cubic-bezier in, 120 ms ease-in out). */
  .sticky-apply {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 50;
    padding: var(--space-2);
    padding-bottom: max(var(--space-2), env(safe-area-inset-bottom));
    background: var(--color-paper);
    border-top: var(--rule-2) solid var(--color-ink);
    display: grid;
    transform: translateY(100%);
    transition: transform 120ms ease-in;
    will-change: transform;
  }
  .sticky-apply.is-visible {
    transform: translateY(0);
    transition: transform 180ms cubic-bezier(0.25, 0, 0.4, 1);
  }
  @media (min-width: 800px) {
    .sticky-apply { display: none; }
  }

  /* ---------- Print ----------
   * Spec §3.7.j: hide rail-top / apply / more-from / sticky / disclosure;
   * render the fact card inline ABOVE the body. */
  @media print {
    .rail-top,
    .apply-card,
    .more-card,
    .sticky-apply,
    .local-state-disclosure {
      display: none;
    }
    .body-grid {
      display: flex;
      flex-direction: column;
    }
    .rail {
      display: contents;
    }
    .fact-card {
      order: -1;
      margin-block: var(--space-3);
      page-break-inside: avoid;
    }
    .body { page-break-before: avoid; }
  }
</style>
