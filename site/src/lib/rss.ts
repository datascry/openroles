import type { Job } from "@openroles/shared";

export interface FeedChannel {
  readonly title: string;
  readonly link: string;
  readonly description: string;
  readonly selfUrl: string;
  readonly lastBuildDate: string;
}

export const FEED_TTL_MINUTES = 1440;
export const FEED_ITEM_CAP = 100;
export const FEED_FRESHNESS_DAYS = 90;

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

function escapeCdata(s: string): string {
  return s.replace(/]]>/g, "]]]]><![CDATA[>");
}

export function toRfc822(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid ISO date: ${iso}`);
  return d.toUTCString();
}

function pubDateOf(job: Job): string {
  return toRfc822(job.posted_at ?? job.first_seen_at);
}

function compareJobs(a: Job, b: Job): number {
  const aPosted = a.posted_at ?? a.first_seen_at;
  const bPosted = b.posted_at ?? b.first_seen_at;
  if (aPosted !== bPosted) return aPosted > bPosted ? -1 : 1;
  if (a.first_seen_at !== b.first_seen_at) return a.first_seen_at > b.first_seen_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function freshJobs(jobs: ReadonlyArray<Job>, now: Date = new Date()): Job[] {
  const cutoff = new Date(now.getTime() - FEED_FRESHNESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return jobs
    .filter((j) => (j.posted_at ?? j.first_seen_at) >= cutoff)
    .slice()
    .sort(compareJobs)
    .slice(0, FEED_ITEM_CAP);
}

function renderItem(job: Job): string {
  const description = `
        <p><strong>${escapeXml(job.company)}</strong> · ${escapeXml(
          job.location_text ?? "Location not specified",
        )}</p>
        <p>Level: ${escapeXml(job.level ?? "Not classified")} · Workplace: ${escapeXml(
          job.workplace_type ?? "Not specified",
        )}</p>
        <p>${escapeXml(job.description_excerpt ?? "")}</p>`;
  const categories: string[] = [`<category>${escapeXml(job.ats)}</category>`];
  if (job.level) categories.push(`<category>${escapeXml(job.level)}</category>`);
  return `
    <item>
      <title>${escapeXml(`${job.title} — ${job.company}`)}</title>
      <link>${escapeXml(job.url)}</link>
      <guid isPermaLink="true">${escapeXml(job.url)}</guid>
      <pubDate>${pubDateOf(job)}</pubDate>
      <description><![CDATA[${escapeCdata(description)}]]></description>
      ${categories.join("\n      ")}
    </item>`;
}

export function renderFeed(channel: FeedChannel, jobs: ReadonlyArray<Job>): string {
  const items = jobs.map(renderItem).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channel.title)}</title>
    <link>${escapeXml(channel.link)}</link>
    <description>${escapeXml(channel.description)}</description>
    <language>en-US</language>
    <lastBuildDate>${toRfc822(channel.lastBuildDate)}</lastBuildDate>
    <atom:link href="${escapeXml(channel.selfUrl)}" rel="self" type="application/rss+xml" />
    <generator>openroles</generator>
    <ttl>${FEED_TTL_MINUTES}</ttl>${items}
  </channel>
</rss>
`;
}
