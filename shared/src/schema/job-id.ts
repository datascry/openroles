import { createHash } from "node:crypto";
import type { ATSId } from "./ats.ts";

export interface JobIdInput {
  readonly ats: ATSId;
  readonly tenant_slug: string;
  readonly source_id: string;
  readonly url: string;
}

const FIELD_SEP = "";

export function jobId(input: JobIdInput): string {
  const payload = [input.ats, input.tenant_slug, input.source_id, input.url].join(FIELD_SEP);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
