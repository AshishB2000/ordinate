<div align="center">

<img src="assets/images/wip-banner.svg" alt="🚧 Work in progress — under active development. Expect rough edges and breaking changes." width="100%" />

<br/><br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/icons/ordinate-dark.svg" />
  <img src="assets/icons/ordinate.svg" alt="" width="104" height="104" />
</picture>

# Ordinate

**Self-hosted, open-source business intelligence.**

Run it in your own infrastructure. Your team opens a URL and signs in with your SSO.<br/>
Bring data in from files or **38 read-only sources**, **prepare** it with a reversible pipeline,<br/>
**visualize** it across **39 chart, map &amp; table types**, and publish **dashboards**.

<sub>Self-hosted · model-agnostic · MIT. Your data stays in your Postgres and your bucket, and **every number is computed by the app.**</sub>

<br/>

<a href="docs/server/README.md"><b>Operator docs</b></a> &nbsp;·&nbsp;
<a href="#quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
<a href="SECURITY.md"><b>Security</b></a> &nbsp;·&nbsp;
<a href="https://github.com/AshishB2000/ordinate/issues"><b>Issues</b></a>

<br/>

<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2f81f7?style=flat-square" /></a>
<img alt="Status" src="https://img.shields.io/badge/status-beta-f0883e?style=flat-square" />
<img alt="Telemetry: none" src="https://img.shields.io/badge/telemetry-none-2ea043?style=flat-square" />
<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
<img alt="React" src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" />
<img alt="Postgres" src="https://img.shields.io/badge/Postgres-4169E1?style=flat-square&logo=postgresql&logoColor=white" />
<img alt="DuckDB" src="https://img.shields.io/badge/DuckDB-FFF000?style=flat-square&logo=duckdb&logoColor=black" />

</div>

---

## What is Ordinate

Ordinate is a web BI workspace your company runs itself: one stateless container image, plus a
Postgres database and an S3 bucket (or a volume) that you provide. People sign in through your
identity provider (OIDC, or a sign-in proxy such as oauth2-proxy), work in **projects** shared with
people and teams by role, and publish dashboards to a link inside your network.

> [!IMPORTANT]
> **The app does the math.** Every aggregate, statistic, metric and anomaly is computed by the
> server, in code paired with differential tests. The browser only formats. An AI model, if you
> connect one, may *extract structure* (a table out of a screenshot) or *narrate figures the app
> already computed*. It is **never** the source of a number.

## Quick start

You need Node.js 24 for a development checkout, or Docker with Compose v2 for the team stack.

### Develop on one machine

```bash
git clone https://github.com/AshishB2000/ordinate.git
cd ordinate
npm install                # also compiles the server and fetches map boundaries
npm --prefix web install
npm run build:web          # the React app, served by the server from web/dist
npm run server             # http://127.0.0.1:8080, signed in as dev@local (admin), data in ./data
```

For hot reload, keep `npm run server` running and start `npm run dev:web` in a second terminal.
Vite serves the app on `http://localhost:5173` and proxies `/api` to the server. Dev mode needs no
Postgres: records are JSON files under `./data`. Dev sign-in is refused in production.

### Run it for a team: Docker Compose

`deploy/docker-compose.yml` runs the server, Postgres 17 and MinIO on one host:

```bash
cd deploy
cp .env.example .env       # then add ORDINATE_MASTER_KEY, the two passwords and ORDINATE_ADMIN_EMAIL
docker compose up -d --build
curl -s http://127.0.0.1:8080/readyz
```

The full walk-through, including generating the secrets and putting a sign-in proxy in front, is
[docs/server/quick-start.md](docs/server/quick-start.md). **Back up `ORDINATE_MASTER_KEY`.** Every
stored connection password and AI key is encrypted under it.

### Run it on Kubernetes: Helm

The chart in `deploy/helm/ordinate` runs migrations as a pre-install/pre-upgrade Job, keeps metrics
on a Service the Ingress never routes, and takes secrets only from a Secret you create:

```bash
helm install ordinate deploy/helm/ordinate -n ordinate -f my-values.yaml --wait
```

Start from [docs/server/eks.md](docs/server/eks.md) (IRSA, RDS, S3, ALB),
[ecs.md](docs/server/ecs.md) or [gke-aks.md](docs/server/gke-aks.md). Every environment variable is
in [configuration.md](docs/server/configuration.md). More than one replica needs sticky sessions at
the load balancer.

## Features at a glance

| | What you get |
|---|---|
| **Bring in** | CSV, JSON and Excel uploads, pasted tables, an https JSON URL, a screenshot read into a table you review, and **38 read-only connectors**. Every query is bounded on the server. |
| **Prepare** | An ordered, reversible pipeline: calculated fields (a hand-written formula language, no `eval`), filters, group and aggregate, dedupe, split and regex replace, pivot and unpivot, joins, window functions and more. Remove a step and the result recomputes from the source. Scheduled pipelines and refreshes. |
| **Visualize** | 39 types: 31 charts, a pivot table, cohort and event-funnel grids, 4 maps and a table. Charts render with Chart.js 4; maps with MapLibre GL over OpenStreetMap tiles. |
| **Analyze** | Statistics, drivers, scenarios, segments, snapshots, events, insights, anomaly detection and a SQL workbench, all computed on the server. |
| **Author and publish** | Analyses with sheets, cards, filter controls and parameters; dashboards published **by value** as read-only snapshots, at `/p/<id>` for your org (or anyone with the link, if an admin allows it). Reports, stories and scorecards export to PDF, PowerPoint and Word. Comments and alerts. |
| **Govern** | Orgs, teams and per-project roles (viewer, editor, admin); an audit log; personal API tokens; an admin console; backup and restore of every project. |
| **Automate** | An MCP endpoint at `/api/mcp` for agents and scripts, signed in with an API token ([docs/automation.md](docs/automation.md)). |
| **Assistant (optional)** | Connect an Anthropic, OpenAI, Gemini or OpenAI-compatible gateway key. The Assistant answers from app-computed facts and proposes plans you approve. Everything works without one. |

Connectors, one registry entry each. Wire-compatible engines share a driver.

| Category | Sources |
|---|---|
| **Databases** (14) | PostgreSQL · CockroachDB · TimescaleDB · YugabyteDB · Materialize · QuestDB · RisingWave · MySQL · MariaDB · Amazon Aurora (MySQL) · TiDB · PlanetScale · Microsoft SQL Server · Oracle Database |
| **Cloud warehouses** (7) | Amazon Redshift · Google AlloyDB · Neon · Supabase · Azure SQL Database · Azure Synapse Analytics · Oracle Autonomous Database |
| **Query engines** (10) | SingleStore · StarRocks · Apache Doris · ClickHouse · Databricks SQL · Trino · Presto · Elasticsearch · OpenSearch · Apache Druid |
| **Apps &amp; SaaS** (6) | Google Sheets · Airtable · Notion · Stripe · GitHub · HubSpot |
| **Web** (1) | URL / API (JSON) |

Identifier columns stay text everywhere: `007`, ZIP codes and IDs longer than 15 digits are never
turned into figures. A dataset holds up to 1,000,000 rows.

## Security model

Responsibility is split. **Ordinate** handles sign-in, sessions, roles and tenant isolation inside
the app; the SSRF guard on every connector; DuckDB locked to each org's own data; secrets encrypted
at rest and never sent to a browser or a log; CSRF protection, CSP and security headers. **You**
handle the network, ingress and TLS, the pod's cloud identity, Postgres and the bucket (including
their encryption and backups), your IdP, and applying releases.

- [docs/phase-7-web/threat-model.md](docs/phase-7-web/threat-model.md) lists every asset, trust
  boundary and mitigation, with the test that proves each one, plus the open and accepted risks.
- [SECURITY.md](SECURITY.md) says how to report a vulnerability privately. Please do not open a
  public issue for one.
- The image never downloads anything at run time, and the app sends no telemetry. The only external
  fetches are OpenStreetMap tiles when a map is on screen, and the model endpoint you connect, if any.

## How it is built

| Layer | What it is |
|---|---|
| **Server** | Node 24, Fastify 5. Every endpoint is an RPC channel with a zod contract and a role check; no contract, no channel. |
| **Web app** | React 19, Vite, React Router, TanStack Query, Radix primitives, CSS Modules. |
| **Metadata** | Postgres: users, orgs, roles, records (row-level security per org), jobs, audit and encrypted secrets. |
| **Tables** | Parquet on a volume or S3, queried in place by DuckDB through one locked worker per org. |
| **Push and jobs** | Server-sent events; jobs claimed from a Postgres table and events fanned out across pods with `LISTEN/NOTIFY`. |
| **Packaging** | One image for amd64 and arm64, a Compose stack, a Helm chart, and `/metrics` for Prometheus on its own port. |

Architecture and conventions are in [CLAUDE.md](CLAUDE.md). The history and the measurements behind
each decision are in [docs/](docs/README.md); Phase 7, the move from a desktop app to this web app,
is [docs/phase-7-web/](docs/phase-7-web/).

## Contributing

Issues and pull requests are welcome. Work goes on a branch off **`develop`** and merges through a PR
once CI is green. The conventions are in [CLAUDE.md](CLAUDE.md).

```bash
npm test                   # every server self-check suite
npm run test:web           # Vitest
npm --prefix web run e2e   # Playwright, one spec per screen, fails on any console error
npm run lint               # oxlint, blocking, zero findings
```

---

<div align="center">

[MIT](LICENSE) © Ordinate contributors

<sub><b>Self-hosted.</b> <b>Model-agnostic.</b> <b>The app does the math.</b></sub>

</div>
