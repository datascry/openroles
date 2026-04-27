import { ATS_IDS, type ATSId, type Manifest } from "@openroles/shared";

export type DriftSeverity = "info" | "warn" | "error";

export interface DriftFinding {
  readonly severity: DriftSeverity;
  readonly code: string;
  readonly message: string;
}

export interface DriftThresholds {
  readonly totalRowsDropFractionWarn: number;
  readonly totalRowsDropFractionError: number;
  readonly atsRowsDropFractionWarn: number;
  readonly atsRowsDropFractionError: number;
  readonly tenantsLiveDropFractionWarn: number;
  readonly tenantsLiveDropFractionError: number;
}

export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = {
  totalRowsDropFractionWarn: 0.1,
  totalRowsDropFractionError: 0.25,
  atsRowsDropFractionWarn: 0.2,
  atsRowsDropFractionError: 0.5,
  tenantsLiveDropFractionWarn: 0.1,
  tenantsLiveDropFractionError: 0.25,
};

function dropFraction(prev: number, curr: number): number {
  if (prev <= 0) return 0;
  return Math.max(0, (prev - curr) / prev);
}

function classifyDrop(
  prev: number,
  curr: number,
  warnAt: number,
  errorAt: number,
): DriftSeverity | null {
  const drop = dropFraction(prev, curr);
  if (drop >= errorAt) return "error";
  if (drop >= warnAt) return "warn";
  return null;
}

export function detectDrift(
  previous: Manifest | null,
  current: Manifest,
  thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS,
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  if (previous === null) {
    findings.push({
      severity: "info",
      code: "first-build",
      message: `first build observed: ${current.total_rows} jobs across ${current.tenants_total} tenants`,
    });
    return findings;
  }

  if (previous.schema_version !== current.schema_version) {
    findings.push({
      severity: "warn",
      code: "schema-version-changed",
      message: `schema_version changed ${previous.schema_version} → ${current.schema_version}`,
    });
  }

  const totalSeverity = classifyDrop(
    previous.total_rows,
    current.total_rows,
    thresholds.totalRowsDropFractionWarn,
    thresholds.totalRowsDropFractionError,
  );
  if (totalSeverity !== null) {
    findings.push({
      severity: totalSeverity,
      code: "total-rows-drop",
      message: `total_rows dropped from ${previous.total_rows} to ${current.total_rows}`,
    });
  }

  for (const ats of ATS_IDS) {
    const prev = previous.ats_counts[ats];
    const curr = current.ats_counts[ats];
    if (prev > 0 && curr === 0) {
      findings.push({
        severity: "error",
        code: "ats-count-zeroed",
        message: `ats_counts.${ats} dropped to 0 (was ${prev})`,
      });
      continue;
    }
    const sev = classifyDrop(
      prev,
      curr,
      thresholds.atsRowsDropFractionWarn,
      thresholds.atsRowsDropFractionError,
    );
    if (sev !== null) {
      findings.push({
        severity: sev,
        code: `ats-drop:${ats satisfies ATSId}`,
        message: `ats_counts.${ats} dropped from ${prev} to ${curr}`,
      });
    }
  }

  const liveSev = classifyDrop(
    previous.tenants_live,
    current.tenants_live,
    thresholds.tenantsLiveDropFractionWarn,
    thresholds.tenantsLiveDropFractionError,
  );
  if (liveSev !== null) {
    findings.push({
      severity: liveSev,
      code: "tenants-live-drop",
      message: `tenants_live dropped from ${previous.tenants_live} to ${current.tenants_live}`,
    });
  }

  return findings;
}

export function maxSeverity(findings: ReadonlyArray<DriftFinding>): DriftSeverity {
  let level: DriftSeverity = "info";
  for (const f of findings) {
    if (f.severity === "error") return "error";
    if (f.severity === "warn") level = "warn";
  }
  return level;
}
