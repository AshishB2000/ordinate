# Security policy

Ordinate is self-hosted: a company runs the server in its own infrastructure and its users sign in
with the company's identity provider. This file says how to report a vulnerability in the software
and what happens after you do. What the software defends, and how each defence is tested, is in
[`docs/phase-7-web/threat-model.md`](docs/phase-7-web/threat-model.md).

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub: open
<https://github.com/AshishB2000/ordinate/security/advisories/new> (the repository's **Security** tab
→ **Report a vulnerability**). Only the maintainers can read the report; the conversation, the fix
and the advisory are drafted there in private.

<!-- TODO(maintainer): GitHub's private vulnerability reporting must be switched on for the link
above to work — Settings → Code security → "Private vulnerability reporting". If a mailbox is ever
wanted as a second channel, add it here; none is published yet. -->

Please include:

- the version or commit you tested, and how the server was configured (`AUTH_MODE`, Postgres,
  `STORAGE_URL` file or S3) — never your real secrets;
- what an attacker needs to start with (signed out, a viewer in the same org, an editor of another
  project, a member of another org, a personal API token, a network position);
- steps to reproduce, and what they let the attacker read, change or deny;
- whether you believe it is already being exploited.

## What happens next

| When | What |
|---|---|
| 3 working days | We acknowledge the report and say who is handling it. |
| 10 working days | We confirm or decline it, with a severity and the reasoning. |
| 90 days at most | A fixed release, then a published GitHub security advisory (with a CVE where one applies). |

We will tell you before we publish and credit you in the advisory unless you ask us not to. If a fix
needs longer than 90 days we will agree a date with you rather than go quiet. Please give us that
window before you disclose publicly.

## Scope

In scope — the software in this repository:

- the server (`src/`): sign-in, sessions, API tokens, authorization and tenant isolation (one org
  reading another's records, files, tables, downloads or event streams), CSRF, the security headers,
  the SSRF guard on connectors and AI providers, the DuckDB lockdown and user SQL, secrets at rest
  and in logs, uploads and downloads, the published-site whitelist;
- the web app (`web/`): cross-site scripting, anything that lets a page act as a signed-in user;
- the build and release artifacts we publish.

Out of scope — the operator's side (plan §8): their network, ingress and TLS, their identity
provider and who it lets in, their Postgres and bucket (encryption, backups), the cluster and its
patching, and a deployment that turns a guard off on purpose (for example `SSRF_ALLOW=0.0.0.0/0`, or
`AUTH_MODE=header` without a trusted proxy in front). Denial of service by volume against a server
with no ingress limits in front, and findings that only affect the desktop app's single local user,
are generally out of scope too — report them anyway if unsure.

## Supported versions

Until the first tagged release, only the latest commit on `develop` receives fixes. After that, the
latest minor release does; operators should run the newest image.

## Dependencies

CI runs `npm audit --omit=dev` on the server and the web app and fails on a **high** or
**critical** advisory in a runtime dependency. An advisory we judge unreachable is recorded, with the
reason, in the threat model's open-risks table until the dependency is upgraded.
