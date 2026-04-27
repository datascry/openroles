import { LEVELS, type Level } from "@openroles/shared";
import type { APIRoute, GetStaticPaths } from "astro";
import { dataDirIsPopulated, openSiteDb } from "../../../lib/db.ts";
import { renderLevelFeed } from "../../../lib/feed-builder.ts";

export const prerender = true;

const NON_NULL_LEVELS = LEVELS.filter((l): l is NonNullable<Level> => l !== null);

export const getStaticPaths: GetStaticPaths = () =>
  NON_NULL_LEVELS.map((level) => ({ params: { level } }));

export const GET: APIRoute = ({ params, site }) => {
  const level = params["level"] as NonNullable<Level> | undefined;
  if (!level || !(NON_NULL_LEVELS as ReadonlyArray<string>).includes(level)) {
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
    return renderLevelFeed(db, level, {
      siteUrl: site?.toString() ?? "https://datascry.github.io/",
      basePath: "openroles",
    });
  } finally {
    db.close();
  }
};
