#!/usr/bin/env bun
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TenantSchema } from "@openroles/shared";
import { z } from "zod";
import { probeMany } from "../src/harvest/probe.ts";
import { HttpClient } from "../src/http.ts";
import { RobotsTxtCache } from "../src/robots.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const path = resolve(HERE, "../../data/tenants/ultipro.json");
console.log("reading", path);

const robots = new RobotsTxtCache();
const client = new HttpClient({
  userAgent: "openroles/1.2.0 (+https://github.com/datascry/openroles)",
  robots,
});
const tenants = z.array(TenantSchema).parse(JSON.parse(await readFile(path, "utf8")));
const slugs = tenants.map((t) => t.slug);
const metaMap = new Map<string, Record<string, string>>();
for (const t of tenants) if (t.metadata) metaMap.set(t.slug, t.metadata);
console.log(`reprobing ${slugs.length} (${metaMap.size} with metadata) at concurrency 6`);
const t0 = Date.now();
const probed = await probeMany("ultipro", slugs, {
  client,
  observedAt: new Date().toISOString(),
  concurrency: 6,
  metadataBySlug: metaMap,
});
await mkdir(dirname(path), { recursive: true });
const tmp = `${path}.tmp`;
await writeFile(tmp, `${JSON.stringify(probed, null, 2)}\n`);
await rename(tmp, path);
let live = 0;
let dead = 0;
let transient = 0;
for (const t of probed) {
  if (t.status === "live") live++;
  else if (t.status === "dead") dead++;
  else transient++;
}
console.log(`done in ${Date.now() - t0}ms: live=${live} dead=${dead} transient=${transient}`);
console.log("wrote", path);
