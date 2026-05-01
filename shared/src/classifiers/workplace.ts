import type { WorkplaceType } from "../schema/workplace.ts";

export interface WorkplaceClassifyInput {
  readonly title: string;
  readonly location_text?: string;
  readonly description_excerpt?: string;
}

// "Hybrid" wins over plain "remote" because hybrid roles routinely include
// the word "remote" alongside in-office requirements ("Remote-friendly with
// 2 days in office"). Test hybrid first so we don't mis-classify those.
const HYBRID_PATTERNS: ReadonlyArray<RegExp> = [
  /\bhybrid\b/i,
  /\b\d+\s*[-–]?\s*(?:days?|x)\s*(?:per\s*week|\/week|in\s*(?:the\s*)?office)\b/i,
  /\bsplit\s*between\s*(?:home|office)\b/i,
  /\boffice\s*(?:and|\+)\s*remote\b/i,
];

const REMOTE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bremote\b/i,
  /\bwork\s*from\s*home\b/i,
  /\bwfh\b/i,
  /\btelecommute\b/i,
  /\bfully\s*(?:remote|distributed)\b/i,
  /\banywhere\s*in\s*(?:the\s*)?(?:us|usa|world|europe|emea)\b/i,
];

const ONSITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bon[\s-]?site\b/i,
  /\bin[\s-]?office\b/i,
  /\boffice[\s-]?based\b/i,
  /\b100%\s*(?:in\s*)?(?:office|onsite)\b/i,
];

export function classifyWorkplace(input: WorkplaceClassifyInput): WorkplaceType {
  // Combine the signals into one haystack — the patterns are mutually
  // distinct enough that scanning a concatenated string yields the same
  // answer as scanning each field separately, with one allocation.
  const haystack = [input.title, input.location_text ?? "", input.description_excerpt ?? ""]
    .join(" ")
    .trim();
  if (haystack.length === 0) return null;
  if (HYBRID_PATTERNS.some((re) => re.test(haystack))) return "hybrid";
  if (REMOTE_PATTERNS.some((re) => re.test(haystack))) return "remote";
  if (ONSITE_PATTERNS.some((re) => re.test(haystack))) return "onsite";
  return null;
}
