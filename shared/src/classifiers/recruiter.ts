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

// Match titles whose head noun is engineering (i.e. the role IS an engineer/dev/etc),
// not titles that merely contain "engineering" as a department modifier.
// "Software Engineer" / "Senior Engineer" → engineering role.
// "Engineering Coordinator" / "Engineering Talent Partner" → not (head noun ≠ engineer).
const ENGINEERING_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bengineer\b\s*$/i,
  /\bengineer\b\s*[,/]/i,
  /\bdeveloper\b\s*$/i,
  /\bdeveloper\b\s*[,/]/i,
  /\bsre\b/i,
  /\barchitect\b\s*$/i,
  /\bdata\s+scientist\b/i,
  /\bsoftware\s+engineer/i,
  /\bsoftware\s+developer/i,
  /\bsystems?\s+engineer/i,
  /\b(?:backend|frontend|fullstack|full-stack|platform|infrastructure|security|ml|ai|qa|test|devops|mobile|ios|android|web)\s+(?:engineer|developer)/i,
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
