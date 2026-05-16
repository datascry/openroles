import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ATSId, type Tenant, TenantSchema } from "@openroles/shared";
import { z } from "zod";

// Cross-ATS de-duplication guard.
//
// The build-db job de-dupes by exact `Job.url` within a build, but the
// same logical job reachable through two different adapters carries two
// different URLs (e.g. a brand live under `eightfold` *and* seeded under
// `gjobsfeed` exposes the same role at two hosts), so it is NOT
// collapsed and the corpus double-counts.
//
// The cheapest place to stop that is at *seed time*: never add a tenant
// to a new ATS when the same slug is already `live` under a different
// one. This module surfaces that "already live elsewhere" set so the
// discovery/seed path can skip it deterministically.

/**
 * Collect the set of slugs that are `status === "live"` under any ATS
 * other than `exceptAts`. Pure — the caller supplies the parsed
 * per-file tenant arrays. A slug live under multiple *other* ATSes
 * still appears once (it is a set).
 */
export function collectLiveSlugsExcluding(
  files: ReadonlyArray<ReadonlyArray<Tenant>>,
  exceptAts: ATSId,
): Set<string> {
  const live = new Set<string>();
  for (const tenants of files) {
    for (const t of tenants) {
      if (t.ats === exceptAts) continue;
      if (t.status === "live") live.add(t.slug);
    }
  }
  return live;
}

/**
 * fs wrapper over {@link collectLiveSlugsExcluding}: reads every
 * `*.json` under `tenantsDir`, parses each as a Tenant[] (silently
 * skipping unreadable / malformed / non-tenant files — discovery must
 * not crash because one unrelated file is bad), and returns the
 * live-elsewhere slug set.
 */
export async function liveSlugsExcluding(
  tenantsDir: string,
  exceptAts: ATSId,
): Promise<Set<string>> {
  let entries: string[];
  try {
    entries = await readdir(tenantsDir);
  } catch {
    return new Set<string>();
  }
  const files: Tenant[][] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const body = await readFile(join(tenantsDir, name), "utf8");
      const parsed = z.array(TenantSchema).safeParse(JSON.parse(body));
      if (parsed.success) files.push(parsed.data);
    } catch {
      // Unreadable / malformed / not a tenant array — ignore.
    }
  }
  return collectLiveSlugsExcluding(files, exceptAts);
}
