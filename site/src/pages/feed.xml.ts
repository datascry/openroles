import type { APIRoute } from "astro";
import { dataDirIsPopulated, openSiteDb } from "../lib/db.ts";
import { renderFullFeed } from "../lib/feed-builder.ts";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  if (!dataDirIsPopulated()) {
    return new Response("data not built; run `bun run build-db` before `bun run build`\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const db = openSiteDb();
  try {
    return renderFullFeed(db, {
      siteUrl: site?.toString() ?? "https://datascry.github.io/",
      basePath: "openroles",
    });
  } finally {
    db.close();
  }
};
