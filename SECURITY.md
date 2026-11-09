# Security

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:
use GitHub's private vulnerability reporting at
<https://github.com/jmedinafruitos/fecapa-sync/security/advisories/new>
("Report a vulnerability" under the repository's **Security** tab).

Include the version, what an attacker can do, and how to reproduce it with
invented data. Don't include real personal data or a SIDGAD token. You should
get an answer within a week. Once a fix is released, the advisory is
published with credit, unless you prefer otherwise.

## Scope

- The library and CLI: path handling (`--out`, `dataDir`, `capture`), the
  local store, the parsers of FECAPA/SIDGAD answers, and the published npm
  package and its provenance.
- **Personal data.** Real names (most players are minors) or a token in this
  repository, a fixture, a release or a workflow log count as security
  issues: report them privately too, and they will be removed (including
  from history where possible).
- FECAPA's portal and the SIDGAD API are not part of this project. Report
  problems with them to the federation.

## Supported versions

Only the latest release gets fixes.

---

**Català.** Informa dels problemes de seguretat **en privat** amb el formulari
de GitHub (pestanya **Security** → «Report a vulnerability»), no en una
incidència pública. Una dada personal real o un token al repositori, a un
fixture o a un registre de CI també compta: informa'n en privat.
