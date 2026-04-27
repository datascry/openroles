# ADR-0006: MIT for code, CC BY-SA 4.0 for data

## Status

Accepted

## Context

Code and data are different legal artifacts and require different licenses. A single-license posture (e.g., MIT covering everything) is technically incoherent — software licenses don't cleanly cover datasets, and dataset licenses don't cleanly cover code. Several adjacent projects in this space publish under a single permissive code license while ignoring the data question, leaving downstream consumers with ambiguous rights.

We will be explicit about both.

## Decision

### Code: MIT

The source code, scripts, configuration, build pipeline, and documentation are licensed under the [MIT License](../../LICENSE). Maximum reuse with minimum friction: the only obligation is preserving the copyright notice. Industry default for the JavaScript / TypeScript ecosystem.

### Data: CC BY-SA 4.0

The dataset published by this project — the harvested tenant lists, the scraped job rows, the level classifications, the dedup decisions, and any derived enrichment — is licensed under [Creative Commons Attribution-ShareAlike 4.0](../../LICENSE-DATA).

CC BY-SA 4.0 has three operative clauses for our purposes:

- **Attribution** — downstream uses must credit this project.
- **ShareAlike** — derivative datasets must be released under the same (or a compatible) license. This prevents proprietary forks of the data.
- **Commercial use is permitted** — unlike CC BY-NC, we do not lock out commercial reuse.

Both license files are committed at the repo root and surfaced in the README. The `package.json` `license` field is `"MIT"`; the dataset license is documented separately because SPDX has no clean way to express "code MIT, data CC BY-SA" in a single field.

## Consequences

### Positive

- Legal posture is explicit; downstream consumers know exactly what they can and cannot do with each artifact.
- Commercial reuse of both code and data is permitted, maximizing adoption.
- ShareAlike on the data prevents a proprietary aggregator from forking our work without contributing back.
- No attribution debt to other open datasets — we harvested clean-room (see ADR-0003).

### Neutral

- Two license files instead of one is mildly more complex but is the legally correct shape.
- Some users may find CC BY-SA's ShareAlike clause inconvenient if they want to mix our data with non-share-alike datasets; that is the intended trade-off.

### Negative

- The `package.json` `license` field cannot express the dataset license; `LICENSE-DATA` and the README explain the full posture.
- Some legal teams flag CC BY-SA on data as "unfamiliar" relative to MIT or Apache. We accept that one-time conversation in exchange for the share-alike protection.

## Alternatives considered

- **MIT for everything** — convenient but legally incoherent: software licenses don't cover datasets cleanly, and a downstream proprietary fork of our data could relicense it freely.
- **Apache 2.0 for code** — adds explicit patent grant and a NOTICE-file requirement. No active patent risk on this codebase; the friction outweighs the benefit. Reconsider if a real patent risk emerges.
- **CC0 / Public Domain for data** — most permissive, but invites proprietary forks with zero attribution. We want signal back to the project.
- **CC BY 4.0 for data (no ShareAlike)** — looser; allows derivatives under any license. Doesn't prevent proprietary forks. Acceptable but weaker than ShareAlike for our case.
- **CC BY-NC for data** — locks out commercial reuse. Limits adoption significantly. Rejected.
- **ODbL** — designed specifically for databases, used by OpenStreetMap. More legally precise than CC BY-SA for compiled databases, but smaller community and more legal-team friction. May revisit if a real legal challenge surfaces.
