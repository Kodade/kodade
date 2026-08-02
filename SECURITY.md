# Security policy

## Supported versions

During the first-public-release cycle, security fixes target the latest stable
release and the current `main` branch. Older local QA builds are unsupported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/Kodade/kodade/security/advisories/new>

Please include:

- the affected version or commit;
- the operating system and architecture;
- clear reproduction steps or a proof of concept;
- the expected and observed security boundary;
- the potential impact; and
- any suggested mitigation, if known.

You should receive an acknowledgement within seven days. Please allow time to
investigate and prepare a coordinated fix before public disclosure.

## Security boundaries worth protecting

Ködade launches local shells and third-party agent CLIs, reads and writes user
projects, and exposes selected local capabilities to its own webview. Reports
involving command construction, path confinement, symlink handling, terminal
process cleanup, agent permissions, KödMCP data separation, browser isolation,
or accidental credential exposure are especially valuable.

Provider accounts and model traffic remain between users and their installed
official CLIs. Ködade should never collect or proxy those credentials.
