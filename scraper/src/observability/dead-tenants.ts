import { ATS_IDS, type ATSId, type Tenant } from "@openroles/shared";

export interface TenantSnapshot {
  readonly observed_at: string;
  readonly tenants: ReadonlyArray<Tenant>;
}

export interface DeadTenantAlert {
  readonly ats: ATSId;
  readonly slug: string;
  readonly consecutive_dead: number;
  readonly first_seen_dead_at: string;
  readonly last_seen_dead_at: string;
}

const ATS_RANK: Record<ATSId, number> = Object.fromEntries(
  ATS_IDS.map((id, i) => [id, i]),
) as Record<ATSId, number>;

function tenantKey(t: { ats: ATSId; slug: string }): string {
  return `${t.ats}${t.slug}`;
}

export function detectDeadTenants(
  history: ReadonlyArray<TenantSnapshot>,
  consecutiveThreshold: number,
): DeadTenantAlert[] {
  if (consecutiveThreshold < 1) {
    throw new Error("consecutiveThreshold must be >= 1");
  }
  if (history.length < consecutiveThreshold) return [];
  const ordered = [...history].sort((a, b) =>
    a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : 0,
  );

  const tail = ordered.slice(-consecutiveThreshold);
  const candidates = new Map<
    string,
    { ats: ATSId; slug: string; firstSeenDead: string; lastSeenDead: string }
  >();

  const firstTail = tail[0];
  if (!firstTail) return [];
  for (const t of firstTail.tenants) {
    if (t.status === "dead") {
      const key = tenantKey(t);
      candidates.set(key, {
        ats: t.ats,
        slug: t.slug,
        firstSeenDead: firstTail.observed_at,
        lastSeenDead: firstTail.observed_at,
      });
    }
  }

  for (let i = 1; i < tail.length; i++) {
    const snap = tail[i];
    if (!snap) continue;
    const stillDead = new Map<string, Tenant>();
    for (const t of snap.tenants) {
      if (t.status === "dead") stillDead.set(tenantKey(t), t);
    }
    for (const [key, info] of candidates) {
      if (!stillDead.has(key)) {
        candidates.delete(key);
      } else {
        candidates.set(key, { ...info, lastSeenDead: snap.observed_at });
      }
    }
  }

  return Array.from(candidates.values())
    .map((c) => ({
      ats: c.ats,
      slug: c.slug,
      consecutive_dead: tail.length,
      first_seen_dead_at: c.firstSeenDead,
      last_seen_dead_at: c.lastSeenDead,
    }))
    .sort((a, b) => {
      if (a.ats !== b.ats) return ATS_RANK[a.ats] - ATS_RANK[b.ats];
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
}
