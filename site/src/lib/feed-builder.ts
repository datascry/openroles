import type { ATSId, Level } from "@openroles/shared";
import { type SiteDb, selectFeedJobs } from "./db.ts";
import { freshJobs, renderFeed } from "./rss.ts";

const RSS_HEADERS = {
  "Content-Type": "application/rss+xml; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
} as const;

export interface FeedSiteContext {
  readonly siteUrl: string;
  readonly basePath: string;
}

function joinUrl(base: string, basePath: string, path: string): string {
  const baseClean = base.replace(/\/+$/, "");
  const middleClean = basePath.replace(/^\/+|\/+$/g, "");
  const pathClean = path.replace(/^\/+/, "");
  const segments = [baseClean, middleClean, pathClean].filter((s) => s.length > 0);
  return segments.join("/");
}

export function renderFullFeed(site: SiteDb, ctx: FeedSiteContext): Response {
  const jobs = freshJobs(selectFeedJobs(site.db, {}));
  const xml = renderFeed(
    {
      title: "openroles — all jobs",
      link: joinUrl(ctx.siteUrl, ctx.basePath, ""),
      description: "Latest jobs across the openroles index",
      selfUrl: joinUrl(ctx.siteUrl, ctx.basePath, "feed.xml"),
      lastBuildDate: site.manifest.built_at,
    },
    jobs,
  );
  return new Response(xml, { headers: RSS_HEADERS });
}

export function renderAtsFeed(site: SiteDb, ats: ATSId, ctx: FeedSiteContext): Response {
  const jobs = freshJobs(selectFeedJobs(site.db, { ats }));
  const xml = renderFeed(
    {
      title: `openroles — ${ats}`,
      link: joinUrl(ctx.siteUrl, ctx.basePath, ""),
      description: `Latest jobs from ${ats} tenants`,
      selfUrl: joinUrl(ctx.siteUrl, ctx.basePath, `feed/${ats}.xml`),
      lastBuildDate: site.manifest.built_at,
    },
    jobs,
  );
  return new Response(xml, { headers: RSS_HEADERS });
}

export function renderLevelFeed(
  site: SiteDb,
  level: NonNullable<Level>,
  ctx: FeedSiteContext,
): Response {
  const jobs = freshJobs(selectFeedJobs(site.db, { level }));
  const xml = renderFeed(
    {
      title: `openroles — ${level} level`,
      link: joinUrl(ctx.siteUrl, ctx.basePath, ""),
      description: `Latest ${level}-level jobs`,
      selfUrl: joinUrl(ctx.siteUrl, ctx.basePath, `feed/level/${level}.xml`),
      lastBuildDate: site.manifest.built_at,
    },
    jobs,
  );
  return new Response(xml, { headers: RSS_HEADERS });
}
