export interface RecruiterClassifyInput {
  readonly title: string;
  readonly department?: string;
}

const RECRUITER_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\brecruiter\b/i,
  /\bsourcer\b/i,
  /\btalent\s+(?:acquisition|partner|sourcing)\b/i,
  /\bhead\s+of\s+talent\b/i,
];

const ENGINEERING_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bengineer(?:ing)?\b/i,
  /\bdeveloper\b/i,
  /\bsre\b/i,
  /\bdata\s+scientist\b/i,
];

const TALENT_DEPARTMENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\btalent\b/i,
  /\bpeople\b/i,
  /\brecruit(?:ing|ment)?\b/i,
];

export function classifyRecruiter(input: RecruiterClassifyInput): boolean {
  const title = input.title.trim();
  if (title.length === 0) return false;
  if (RECRUITER_TITLE_PATTERNS.some((re) => re.test(title))) return true;
  if (ENGINEERING_TITLE_PATTERNS.some((re) => re.test(title))) return false;
  const department = input.department;
  if (department && TALENT_DEPARTMENT_PATTERNS.some((re) => re.test(department))) return true;
  return false;
}
