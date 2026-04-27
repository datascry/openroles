import { ATS_IDS, type Manifest, type ScrapeOutput } from "@openroles/shared";
import type { DeadTenantAlert } from "./dead-tenants.ts";
import type { DriftFinding } from "./drift.ts";

export interface RunReportInput {
  readonly manifest: Manifest;
  readonly outputs: ReadonlyArray<ScrapeOutput>;
  readonly drift?: ReadonlyArray<DriftFinding>;
  readonly deadTenants?: ReadonlyArray<DeadTenantAlert>;
}

function fmtNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

function severityIcon(s: DriftFinding["severity"]): string {
  switch (s) {
    case "error":
      return "[ERROR]";
    case "warn":
      return "[WARN]";
    case "info":
      return "[info]";
  }
}

export function renderRunReport(input: RunReportInput): string {
  const { manifest, outputs } = input;
  const drift = input.drift ?? [];
  const deadTenants = input.deadTenants ?? [];

  const totalRequests = outputs.reduce((acc, o) => acc + o.metrics.requests_made, 0);
  const totalFailed = outputs.reduce((acc, o) => acc + o.metrics.requests_failed, 0);
  const totalRetried = outputs.reduce((acc, o) => acc + o.metrics.requests_retried, 0);
  const totalBytes = outputs.reduce((acc, o) => acc + o.metrics.bytes_received, 0);
  const totalMs = outputs.reduce((acc, o) => acc + o.metrics.duration_ms, 0);

  const lines: string[] = [];
  lines.push(`# openroles run report — ${manifest.short_sha}`);
  lines.push("");
  lines.push(`**Built at:** ${manifest.built_at}`);
  lines.push(`**Schema version:** ${manifest.schema_version}`);
  lines.push(`**Database:** \`${manifest.db_filename}\``);
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- Jobs: **${fmtNumber(manifest.total_rows)}**`);
  lines.push(
    `- Tenants: ${fmtNumber(manifest.tenants_total)} total, ${fmtNumber(manifest.tenants_live)} live`,
  );
  lines.push(
    `- Requests: ${fmtNumber(totalRequests)} (failed ${fmtNumber(totalFailed)}, retried ${fmtNumber(totalRetried)})`,
  );
  lines.push(`- Bytes received: ${fmtNumber(totalBytes)}`);
  lines.push(`- Wall time: ${fmtDuration(totalMs)}`);
  lines.push("");
  lines.push("## Per-ATS counts");
  lines.push("");
  lines.push("| ATS | Jobs |");
  lines.push("| --- | ---: |");
  for (const ats of ATS_IDS) {
    lines.push(`| ${ats} | ${fmtNumber(manifest.ats_counts[ats])} |`);
  }
  lines.push("");
  lines.push("## Drift");
  lines.push("");
  if (drift.length === 0) {
    lines.push("_No drift findings._");
  } else {
    for (const f of drift) {
      lines.push(`- ${severityIcon(f.severity)} \`${f.code}\` — ${f.message}`);
    }
  }
  lines.push("");
  lines.push("## Dead tenants");
  lines.push("");
  if (deadTenants.length === 0) {
    lines.push("_No tenants exceed the consecutive-dead threshold._");
  } else {
    lines.push("| ATS | Slug | Consecutive dead runs | First seen dead | Last seen dead |");
    lines.push("| --- | --- | ---: | --- | --- |");
    for (const a of deadTenants) {
      lines.push(
        `| ${a.ats} | ${a.slug} | ${a.consecutive_dead} | ${a.first_seen_dead_at} | ${a.last_seen_dead_at} |`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
