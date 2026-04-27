import { ATS_IDS, type ATSId } from "@openroles/shared";
import type { APIRoute, GetStaticPaths } from "astro";
import { dataDirIsPopulated, openSiteDb } from "../../lib/db.ts";
import { renderAtsFeed } from "../../lib/feed-builder.ts";

export const prerender = true;

export const getStaticPaths: GetStaticPaths = () => ATS_IDS.map((ats) => ({ params: { ats } }));

export const GET: APIRoute = ({ params, site }) => {
  const ats = params["ats"] as ATSId | undefined;
  if (!ats || !(ATS_IDS as ReadonlyArray<string>).includes(ats)) {
    return new Response("not found\n", { status: 404 });
  }
  if (!dataDirIsPopulated()) {
    return new Response("data not built; run `bun run build-db` before `bun run build`\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const db = openSiteDb();
  try {
    return renderAtsFeed(db, ats, {
      siteUrl: site?.toString() ?? "https://datascry.github.io/",
      basePath: "openroles",
    });
  } finally {
    db.close();
  }
};
