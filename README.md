<div align="center">

<img src="assets/images/wip-banner.svg" alt="🚧 Work in progress — under active development. Expect rough edges and breaking changes." width="100%" />

<br/><br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/icons/ordinate-dark.svg" />
  <img src="assets/icons/ordinate.svg" alt="" width="96" height="96" />
</picture>

# Ordinate

### Open-source AI BI you host yourself

Connect your data, build dashboards, and let AI analyse it for you.

<a href="#-quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
<a href="#-features"><b>Features</b></a> &nbsp;·&nbsp;
<a href="docs/server/README.md"><b>Deploy</b></a> &nbsp;·&nbsp;
<a href="SECURITY.md"><b>Security</b></a> &nbsp;·&nbsp;
<a href="https://github.com/AshishB2000/ordinate/issues"><b>Issues</b></a>

<br/>

<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2f81f7?style=flat-square" /></a>
<img alt="Status: beta" src="https://img.shields.io/badge/status-beta-f0883e?style=flat-square" />
<img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-Docker%20%C2%B7%20Helm-2496ED?style=flat-square&logo=docker&logoColor=white" />
<img alt="Telemetry: none" src="https://img.shields.io/badge/telemetry-none-2ea043?style=flat-square" />
<br/>
<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
<img alt="React" src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" />
<img alt="Postgres" src="https://img.shields.io/badge/Postgres-4169E1?style=flat-square&logo=postgresql&logoColor=white" />
<img alt="DuckDB" src="https://img.shields.io/badge/DuckDB-FFF000?style=flat-square&logo=duckdb&logoColor=black" />

<br/><br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/images/screens/hero-dark.png" />
  <img src="assets/images/screens/hero-light.png" alt="An Ordinate analysis: four KPI cards, revenue by month, revenue by category and a profit-by-state map" width="100%" />
</picture>

</div>

<br/>

## ✨ Why Ordinate

- **Yours to run.** One container image plus your own Postgres and S3 bucket. Deploy with Docker
  Compose, Kubernetes (Helm), or ECS. Your data never leaves your infrastructure.
- **AI built in.** Ask questions about your data in plain words, have AI explain the changes that
  stand out, and let it suggest charts, prepare steps and calculated fields.
- **A complete BI workflow.** Connect 38 sources, clean data with a reversible pipeline, chart it
  across 39 chart, map and table types, and publish dashboards your whole team can open.
- **Built for teams.** Sign in with your company SSO, share projects by role, and keep an audit
  log of who changed what.
- **Open source.** MIT licensed, no telemetry, and you choose the AI model (or none at all).

## 🖼️ A quick look

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/images/screens/home.png" alt="Home: ask about your data, get-started steps and the changes that stand out" />
      <p align="center"><b>Home</b> — ask about your data, and see what stands out</p>
    </td>
    <td width="50%" valign="top">
      <img src="assets/images/screens/data.png" alt="A dataset page with typed columns and 5,000 rows" />
      <p align="center"><b>Data</b> — every dataset with its quality, columns and history</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/images/screens/visual.png" alt="The visual builder with a revenue-by-month line chart" />
      <p align="center"><b>Visuals</b> — build any of 39 chart, map and table types</p>
    </td>
    <td width="50%" valign="top">
      <img src="assets/images/screens/stats.png" alt="A correlation matrix in the statistics workbench" />
      <p align="center"><b>Analytics</b> — correlation, regression, drivers and more</p>
    </td>
  </tr>
</table>

## 🤖 AI that works with your data

Connect an Anthropic, OpenAI, Gemini or OpenAI-compatible model, and Ordinate puts it to work:

| | |
|---|---|
| **Ask anything** | Type a question on Home or in the Assistant and get an answer built from your datasets. |
| **What stands out** | Notable rises, drops and anomalies are found for you, each with a one-click *Ask why*. |
| **Suggestions** | Suggested charts, prepare steps and calculated fields, plus drafted dashboard layouts. |
| **Plans you approve** | The Assistant proposes multi-step plans, and nothing runs until you say so. |
| **Agents and scripts** | An MCP endpoint at `/api/mcp` lets AI agents work with Ordinate using an API token. |

Answers are grounded in figures Ordinate calculates from your data, and every feature also works
without a model.

## 🚀 Quick start

### Try it on your machine

You need **Node.js 24**.

```bash
git clone https://github.com/AshishB2000/ordinate.git
cd ordinate
npm install && npm --prefix web install
npm run build:web
npm run server
```

Open **http://localhost:8080**. You're signed in automatically as a local admin, and your data is
kept in `./data`. No database is needed for this mode.

### Run it for a team with Docker Compose

Ordinate, Postgres 17 and MinIO on one host:

```bash
cd deploy
cp .env.example .env       # add ORDINATE_MASTER_KEY, the two passwords and ORDINATE_ADMIN_EMAIL
docker compose up -d --build
```

The full walk-through, including generating secrets and putting your SSO in front, is in
[docs/server/quick-start.md](docs/server/quick-start.md).

> [!WARNING]
> **Back up `ORDINATE_MASTER_KEY`.** Every stored connection password and AI key is encrypted
> under it. Without it they can't be read, even from a good database backup.

### Deploy on Kubernetes with Helm

```bash
helm install ordinate deploy/helm/ordinate -n ordinate -f my-values.yaml --wait
```

Step-by-step guides: [EKS](docs/server/eks.md) · [ECS](docs/server/ecs.md) ·
[GKE / AKS](docs/server/gke-aks.md) · [SSO setup](docs/server/sso.md) ·
[all settings](docs/server/configuration.md) · [sizing](docs/server/sizing.md) ·
[backup](docs/server/backup-restore.md) · [upgrades](docs/server/upgrade.md)

## 🧩 Features

| | |
|---|---|
| **📥 Bring data in** | Upload CSV, JSON or Excel, paste a table, point at a JSON URL, read a table out of a screenshot, or connect one of **38 read-only sources**. Datasets hold up to 1,000,000 rows. |
| **🧹 Prepare** | A step-by-step pipeline you can reorder or undo: calculated fields, filters, grouping, joins, pivot and unpivot, dedupe, regex, window functions and more. Refreshes and pipelines run on a schedule. |
| **📊 Visualize** | **39 types**: 31 charts, a pivot table, cohort and event-funnel grids, 4 maps and a table. Small multiples, drill-down, annotations, reference lines and forecasts. |
| **🔬 Analyze** | Statistics, key drivers, what-if scenarios, segments, snapshots, events and a SQL workbench. |
| **🗂️ Author and share** | Analyses with sheets, cards, filters and parameters; publish them as dashboards your org can open at a link. Reports, stories and scorecards export to PDF, PowerPoint and Word. Comments and alerts keep the team in the loop. |
| **🛡️ Govern** | SSO sign-in, orgs, teams and per-project roles (viewer, editor, admin), an audit log, personal API tokens, an admin console, and backup and restore. |

<details>
<summary><b>All 38 connectors</b></summary>
<br/>

| Category | Sources |
|---|---|
| **Databases** (14) | PostgreSQL · CockroachDB · TimescaleDB · YugabyteDB · Materialize · QuestDB · RisingWave · MySQL · MariaDB · Amazon Aurora (MySQL) · TiDB · PlanetScale · Microsoft SQL Server · Oracle Database |
| **Cloud warehouses** (7) | Amazon Redshift · Google AlloyDB · Neon · Supabase · Azure SQL Database · Azure Synapse Analytics · Oracle Autonomous Database |
| **Query engines** (10) | SingleStore · StarRocks · Apache Doris · ClickHouse · Databricks SQL · Trino · Presto · Elasticsearch · OpenSearch · Apache Druid |
| **Apps &amp; SaaS** (6) | Google Sheets · Airtable · Notion · Stripe · GitHub · HubSpot |
| **Web** (1) | URL / API (JSON) |

Every connector is read-only, and every query is limited on the server. Identifier columns stay
text, so `007`, ZIP codes and long IDs are never turned into numbers.

</details>

## 🔒 Security

Ordinate runs inside your network, so security is shared:

| **Ordinate takes care of** | **You take care of** |
|---|---|
| Sign-in, sessions, roles and keeping each org's data separate | Your network, ingress and TLS |
| Blocking connectors from reaching internal addresses | The pod's cloud permissions |
| Encrypting stored passwords and AI keys, and never sending them to a browser or a log | Your Postgres and bucket, including their backups |
| CSRF protection, a strict content security policy and security headers | Your identity provider and who can sign in |
| Fixing vulnerabilities and shipping patched releases | Applying those releases |

The image downloads nothing at run time, and Ordinate sends no telemetry. The full threat model,
with the test behind each protection, is in
[docs/phase-7-web/threat-model.md](docs/phase-7-web/threat-model.md). To report a vulnerability,
see [SECURITY.md](SECURITY.md); please don't open a public issue for one.

<details>
<summary><b>🛠️ How it's built</b></summary>
<br/>

| Layer | What it is |
|---|---|
| **Server** | Node 24 and Fastify 5. Every endpoint is a typed RPC call with a validated input and a role check. |
| **Web app** | React 19, Vite, React Router, TanStack Query and Radix, styled with CSS Modules. |
| **Metadata** | Postgres: users, orgs, roles, records with row-level security per org, jobs, audit log and encrypted secrets. |
| **Tables** | Parquet on a volume or S3, queried in place by DuckDB, one locked worker per org. |
| **Live updates and jobs** | Server-sent events, plus a Postgres job queue shared across pods. |
| **Packaging** | One image for amd64 and arm64, a Compose stack, a Helm chart, and Prometheus `/metrics` on its own port. |

Architecture and conventions are in [CLAUDE.md](CLAUDE.md). The decisions and the measurements
behind them are in [docs/](docs/README.md).

</details>

## 🤝 Contributing

Issues and pull requests are welcome. Branch off **`develop`**, and open a PR once CI is green.

```bash
npm test                   # server test suites
npm run test:web           # web unit tests
npm --prefix web run e2e   # end-to-end tests, one per screen
npm run lint               # lint (must be zero findings)
```

---

<div align="center">

[MIT](LICENSE) © Ordinate contributors

<sub><b>Open source.</b> <b>Self-hosted.</b> <b>AI-powered.</b></sub>

</div>
