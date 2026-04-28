// Re-probe specific ATSes (use after fixing probe URLs).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ATSId, TenantSchema } from "@openroles/shared";
import { z } from "zod";
import { probeMany } from "../src/harvest/probe.ts";
import { HttpClient } from "../src/http.ts";
import { RobotsTxtCache } from "../src/robots.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, "../../data/tenants");
const robots = new RobotsTxtCache();
const client = new HttpClient({
  userAgent: "openroles/1.2.0 (+https://github.com/datascry/openroles)",
  robots,
});

const targets: ATSId[] = ["smartrecruiters", "workable"];
for (const ats of targets) {
  const path = join(DATA_DIR, `${ats}.json`);
  const tenants = z.array(TenantSchema).parse(JSON.parse(await readFile(path, "utf8")));
  console.log(`[${ats}] re-probing ${tenants.length} slugs...`);
  const t0 = Date.now();
  const probed = await probeMany(
    ats,
    tenants.map((t) => t.slug),
    { client, observedAt: new Date().toISOString(), concurrency: 12 },
  );
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(probed, null, 2)}\n`);
  await rename(tmp, path);
  let live = 0;
  let dead = 0;
  let transient = 0;
  for (const t of probed) {
    if (t.status === "live") live += 1;
    else if (t.status === "dead") dead += 1;
    else transient += 1;
  }
  console.log(`[${ats}] live=${live} dead=${dead} transient=${transient} (${Date.now() - t0}ms)`);
}
