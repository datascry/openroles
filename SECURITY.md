# Security Policy

## Supported Versions

This project ships continuously. Only the latest commit on `main` is supported.

## Reporting a Vulnerability

If you discover a security issue — including but not limited to credential
exposure in committed artifacts, dependency CVEs that affect runtime
behavior, or any issue that could compromise consumers of the published
dataset — please report it privately via GitHub's "Report a vulnerability"
flow on this repository's Security tab.

Please do not open a public issue for security reports. We'll triage within
72 hours and coordinate disclosure once a fix is available.

## What's in scope

- Code in this repository (scraper, site, shared, scripts).
- The published static site at the GitHub Pages URL for this repository.
- The published dataset artifacts (`*.sqlite`, `*.parquet`) attached to GitHub Releases.

## What's out of scope

- Vulnerabilities in upstream Applicant Tracking Systems whose public APIs
  this project consumes. Report those to the ATS vendor directly.
- Vulnerabilities in third-party dependencies; report to the dependency
  maintainer first. We will track the CVE and ship the upstream fix.
- Issues already disclosed in our public dependency-review or CodeQL CI runs.

## Hardening posture

- All ATS scrapers honor the target's `robots.txt` and rate-limit politely.
- The User-Agent identifies this project and includes a contact URL.
- No user-controlled input reaches a SQL query without parameter binding.
- The static site requires no cookies and no third-party requests at runtime.
- CI runs CodeQL and dependency review on every PR.
