// Conventional Commits enforcement.
// https://www.conventionalcommits.org/

module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "style",
        "refactor",
        "test",
        "chore",
        "ci",
        "build",
        "perf",
        "revert",
      ],
    ],
    "subject-case": [2, "always", ["lower-case", "sentence-case"]],
    "subject-full-stop": [2, "never", "."],
    "subject-empty": [2, "never"],
    "type-empty": [2, "never"],
    "header-max-length": [2, "always", 72],
    "body-leading-blank": [1, "always"],
    "body-max-line-length": [2, "always", 100],
    "footer-leading-blank": [1, "always"],
    "scope-case": [2, "always", "lower-case"],
  },
  helpUrl:
    "https://www.conventionalcommits.org/en/v1.0.0/  —  use `type(scope): summary` (e.g. feat(scraper): add lever parser)",
};
