<div align="center">

<img src="assets/images/wip-banner.svg" alt="🚧 Work in progress — under active development. Expect rough edges and breaking changes." width="100%" />

<br/><br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/icons/ordinate-dark.svg" />
  <img src="assets/icons/ordinate.svg" alt="" width="96" height="96" />
</picture>

# Ordinate

### Open-source AI BI you host yourself

Connect your data, define what it means once, build dashboards, and ask questions in plain words.

<a href="#-quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
<a href="#-features"><b>Features</b></a> &nbsp;·&nbsp;
<a href="#-data-model"><b>Data model</b></a> &nbsp;·&nbsp;
<a href="#-connectors"><b>Connectors</b></a> &nbsp;·&nbsp;
<a href="docs/server/README.md"><b>Deploy</b></a> &nbsp;·&nbsp;
<a href="#-documentation"><b>Docs</b></a> &nbsp;·&nbsp;
<a href="SECURITY.md"><b>Security</b></a>

<br/>

<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2f81f7?style=flat-square" /></a>
<img alt="Status: beta" src="https://img.shields.io/badge/status-beta-f0883e?style=flat-square" />
<img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-Docker%20%C2%B7%20Helm%20%C2%B7%20ECS-2496ED?style=flat-square&logo=docker&logoColor=white" />
<img alt="44 sources" src="https://img.shields.io/badge/sources-44-8957e5?style=flat-square" />
<img alt="39 chart types" src="https://img.shields.io/badge/chart%20types-39-8957e5?style=flat-square" />
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

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>🏠 Yours to run</h3>
      One container image, plus your own Postgres and S3 bucket. Deploy with Docker Compose,
      Kubernetes (Helm) or ECS. MIT licensed, no telemetry, and your data stays in your
      infrastructure.
    </td>
    <td width="33%" valign="top">
      <h3>📖 One meaning for every number</h3>
      The <b>Data model</b> says what each dataset, field, metric and business word means, so
      every chart, dashboard, AI answer and agent uses the same definitions.
    </td>
    <td width="33%" valign="top">
      <h3>🤖 AI that sticks to your data</h3>
      Ask questions in plain words, get the changes that stand out explained, and draft charts
      and dashboards. You choose the model, or use none.
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <h3>⚡ Live or copied</h3>
      Copy a table into Ordinate, or keep it <b>Live</b> so every chart asks your warehouse, or
      the semantic layer you already have, and says how fresh the number is.
    </td>
    <td width="33%" valign="top">
      <h3>📊 The whole BI workflow</h3>
      44 sources, a reversible prepare pipeline, 39 chart, map and table types, and dashboards
      your team opens at a link.
    </td>
    <td width="33%" valign="top">
      <h3>👥 Built for teams</h3>
      Single sign-on, orgs, teams and per-project roles, row access rules, an audit log, API
      tokens and an admin console.
    </td>
  </tr>
</table>

## 🧭 How it works

```mermaid
flowchart LR
  S["📥 <b>Connect</b><br/>files · 44 sources<br/>screenshots"] --> P["🧹 <b>Prepare</b><br/>reversible steps"]
  P --> M["📖 <b>Define</b><br/>metrics · glossary<br/>relationships"]
  M --> V["📊 <b>Visualize</b><br/>39 chart, map<br/>and table types"]
  V --> D["🗂️ <b>Dashboards</b><br/>filters · parameters<br/>draft, then publish"]
  D --> X["🔗 <b>Share</b><br/>a link · embeds · Slack<br/>PDF · PowerPoint · Word"]
  AI(["🤖 AI assistant"]) -.-> P
  AI -.-> V
  AI -.-> D
```

Every total, average and trend is calculated by Ordinate or by your warehouse. AI reads your
definitions, explains those figures and suggests what to build next; it never makes up a number.

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
      <img src="assets/images/screens/map.png" alt="A region map of profit by US state in the visual builder" />
      <p align="center"><b>Maps</b> — region, bubble, hexbin and flow maps</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/images/screens/stats.png" alt="A correlation matrix in the statistics workbench" />
      <p align="center"><b>Analytics</b> — correlation, regression, drivers and more</p>
    </td>
    <td width="50%" valign="top">
      <img src="assets/images/screens/admin-ai.png" alt="Admin → AI: two connected providers and the models members can use" />
      <p align="center"><b>Admin → AI</b> — connect providers once, approve the models your team may use</p>
    </td>
  </tr>
</table>

## 📖 Data model

The **Data model** is Ordinate's semantic layer: one place that says what your data means. Define a
metric once and every chart, KPI, dashboard, AI answer and agent uses the same definition and gets
the same number.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/images/screens/model-dark.png" />
  <img src="assets/images/screens/model-light.png" alt="The Data model's Metrics tab: six metrics with their definitions, whether each adds up, its value, a trend and where it is used" width="100%" />
</picture>

| | |
|---|---|
| **Datasets** | What one row is, a checked key, and a written guide to querying it. Fields get descriptions, display names and value labels. Source tables document themselves from the warehouse's own comments and keys. |
| **Metrics** | The formula, the date it counts by, and whether it adds up across rows. Also distinct counts, funnels, snapshot balances, year-to-date and other period metrics, and targets. A chart built on a metric follows it when the definition changes. |
| **Glossary** | Business words and their other names ("EMEA", "big orders"), each with the filter it stands for, so the Assistant reads them the way your team does. |
| **Relationships** | How datasets join, labelled when one table joins two ways (order date or ship date). A join that would repeat rows is computed correctly instead of refused. |
| **Navigation** | Hierarchies for drill-down (region › state), and topics that narrow the model to what one team needs. |
| **Assistant** | Instructions everyone's Assistant reads, and verified questions: answers the team checked, given the same way every time. |
| **Governance** | Certify or retire a dataset or metric, see what uses it, hide a column or metric from a role, and follow column-level lineage. |
| **Portability** | Export the model as plain files to review in git, then import them back. Import dbt's semantic models and metrics, and export to [Apache Ossie](https://github.com/apache/ossie), the open semantic interchange format. |

Already have a semantic layer? Connect **Cube**, the **dbt Semantic Layer** or **Snowflake semantic
views**, and Ordinate queries their metrics live. Details: [docs/semantic-layer](docs/semantic-layer/README.md)
and [model files in git](docs/server/model-files.md).

## 🤖 AI that works with your data

| | |
|---|---|
| **Ask anything** | Type a question on Home or in the Assistant and get an answer built from your datasets and metrics. |
| **What stands out** | Notable rises, drops and anomalies are found for you, each with a one-click *Ask why*. |
| **Suggestions** | Suggested charts, prepare steps and calculated fields, plus drafted dashboard layouts. |
| **Plans you approve** | The Assistant proposes multi-step plans, and nothing runs until you say so. |
| **Read a screenshot** | Upload a picture of a table or chart and get an editable dataset back. |
| **Agents and scripts** | An MCP endpoint at `/api/mcp` lets AI agents work with Ordinate using an API token. |

**Admins stay in control.** An admin connects Anthropic, OpenAI, Google Gemini or any
OpenAI-compatible gateway once, in **Admin → AI**, and approves the exact models the team may use.
Everyone else just picks a model from that list; they never see an API key. Keys are encrypted and
never shown again. Setup guide: [docs/server/ai.md](docs/server/ai.md).

With no model connected, the AI features stay off and everything else works.

## ⚡ Live or copied data

Each dataset is one of two kinds, and you can switch either way:

| | **Copy** | **Live** |
|---|---|---|
| **Where the rows are** | Imported into Ordinate (up to 1,000,000 rows) | They stay in your warehouse |
| **Who does the math** | Ordinate's own engine | Your warehouse, with SQL Ordinate writes, or your semantic layer |
| **How fresh** | As of the last refresh, on a schedule you set | As fresh as the cache age you choose, from *always live* to 1 day |
| **Works with** | Every source | Snowflake, BigQuery, Redshift, Databricks SQL and ClickHouse; PostgreSQL, TimescaleDB, AlloyDB, Neon and Supabase on a read replica; Cube, dbt Semantic Layer and Snowflake semantic views |
| **Best for** | Preparing, statistics, maps, pivots and row-level tools | Big tables and numbers that must be current |

Every figure says which it is: *As of 1:00 AM*, *Live · 2:05 AM*, or *Stale* when the warehouse
couldn't be reached. A Live table can carry always-applied filters and calculated fields of its own.
Warehouse queries are capped per org per day, and a refresh URL lets dbt or Airflow tell Ordinate
when new data has landed. Details: [docs/server/live-data.md](docs/server/live-data.md).

## 🚀 Quick start

### Run it with Docker Compose

This starts Ordinate with Postgres and MinIO on one machine. You need Docker with Compose v2.

```bash
git clone https://github.com/AshishB2000/ordinate.git
cd ordinate/deploy
cp .env.example .env
cat >> .env <<EOF
ORDINATE_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
EOF
docker compose up -d --build
docker compose logs ordinate | grep "setup code"
```

Open **http://127.0.0.1:8080**, enter the setup code, and create the admin account. Add your
teammates in **Admin → People**. The full walk-through is in
[docs/server/quick-start.md](docs/server/quick-start.md).

> [!WARNING]
> **Keep a copy of `ORDINATE_MASTER_KEY`.** Every stored connection password and AI key is encrypted
> under it. Without it they can't be read, even from a good database backup.

> [!NOTE]
> Password sign-in is for trying Ordinate out. Before real use, switch to your company's single
> sign-on: [docs/server/sso.md](docs/server/sso.md).

### Deploy on Kubernetes or ECS

```bash
helm install ordinate deploy/helm/ordinate -n ordinate -f my-values.yaml --wait
```

Step-by-step guides: [EKS](docs/server/eks.md) · [ECS](docs/server/ecs.md) ·
[GKE / AKS](docs/server/gke-aks.md)

<details>
<summary><b>Run from source, for development</b></summary>
<br/>

You need **Node.js 24**.

```bash
git clone https://github.com/AshishB2000/ordinate.git
cd ordinate
npm install && npm --prefix web install
npm run build:web
AUTH_MODE=dev npm run server
```

Open **http://localhost:8080**. `AUTH_MODE=dev` signs you in as a local admin with no database,
and keeps your data in `./data`. It is for development only: accounts, roles and AI setup need
Postgres, so use the Compose stack above to try those.

For UI work, run `npm run dev:web` beside the server for hot reload.

</details>

## 🧩 Features

| | |
|---|---|
| **📥 Bring data in** | Upload CSV, JSON or Excel, paste a table, point at a JSON URL, read a table out of a screenshot, or connect one of **44 read-only sources**. Copy the data, or keep a warehouse table Live. |
| **🧹 Prepare** | A step-by-step pipeline you can reorder or undo: calculated fields, filters, grouping, joins, pivot and unpivot, dedupe, regex, window functions and more. Refreshes and pipelines run on a schedule. |
| **📖 Define** | The Data model: dataset guides and keys, field docs and value labels, metrics with targets, a glossary, relationships, hierarchies and verified questions, exportable as files for git. |
| **📊 Visualize** | **39 types**: 31 charts, a pivot table, cohort and event-funnel grids, 4 maps and a table. Small multiples, drill-down, annotations, reference lines and forecasts. |
| **🔬 Analyze** | Statistics, key drivers, what-if scenarios, segments, snapshots, events and a SQL workbench. |
| **🗂️ Dashboards and sharing** | Dashboards with sheets, cards, filters and parameters, kept as a draft until you publish. Your org opens them at a link; embed them in your own app, or send them to Slack, Teams or email on a schedule. Reports, stories and scorecards export to PDF, PowerPoint and Word. Comments and alerts keep the team in the loop. |
| **🛡️ Govern** | Single sign-on, orgs, teams and per-project roles (viewer, editor, admin), row access rules, a share policy for sensitive columns, an audit log, personal API tokens, an admin console with AI and warehouse-usage controls, and backup and restore. |

## 🔌 Connectors

**44 read-only sources.** ⚡ marks the ones that can also run **Live**.

| Category | Sources |
|---|---|
| **Cloud warehouses** (9) | Snowflake ⚡ · Google BigQuery ⚡ · Amazon Redshift ⚡ · Google AlloyDB ⚡ · Neon ⚡ · Supabase ⚡ · Azure SQL Database · Azure Synapse Analytics · Oracle Autonomous Database |
| **Databases** (15) | PostgreSQL ⚡ · TimescaleDB ⚡ · CockroachDB · YugabyteDB · Materialize · QuestDB · RisingWave · MySQL · MariaDB · Amazon Aurora (MySQL) · TiDB · PlanetScale · Microsoft SQL Server · Oracle Database · MongoDB |
| **Query engines** (11) | Databricks SQL ⚡ · ClickHouse ⚡ · SingleStore · StarRocks · Apache Doris · Trino · Presto · Elasticsearch · OpenSearch · Apache Druid · Amazon Athena |
| **Semantic layers** (2) | Cube ⚡ · dbt Semantic Layer (beta) ⚡ — and Snowflake semantic views, through a Snowflake connection |
| **Apps and SaaS** (6) | Google Sheets · Airtable · Notion · Stripe · GitHub · HubSpot |
| **Web** (1) | URL / API (JSON) |

Every connector is read-only, and every query is limited on the server. Identifier columns stay
text, so `007`, ZIP codes and long IDs are never turned into numbers. The PostgreSQL family
(PostgreSQL, TimescaleDB, AlloyDB, Neon, Supabase) runs Live only when you mark the connection as a
read replica or a warehouse.

## 🔒 Security

Ordinate runs inside your network, so security is shared:

| **Ordinate takes care of** | **You take care of** |
|---|---|
| Sign-in, sessions, roles and keeping each org's data separate | Your network, ingress and TLS |
| Row access rules and hidden columns, held on every screen and API that reads data | The pod's cloud permissions |
| Blocking connectors and AI calls from reaching internal addresses | Your Postgres and bucket, including their backups |
| Encrypting stored passwords and AI keys, and never sending them to a browser or a log | Your identity provider and who can sign in |
| CSRF protection, a strict content security policy and security headers | Who you share published links with |
| Fixing vulnerabilities and shipping patches | Applying those patches |

The image downloads nothing at run time, and Ordinate sends no telemetry. What leaves your
network, and when, is in [PRIVACY.md](PRIVACY.md). The full threat model, with the test behind each
protection, is in [docs/phase-7-web/threat-model.md](docs/phase-7-web/threat-model.md). To report a
vulnerability, see [SECURITY.md](SECURITY.md); please don't open a public issue for one.

## 📚 Documentation

| If you want to… | Read |
|---|---|
| Try it on one machine | [Quick start with Docker Compose](docs/server/quick-start.md) |
| Run it for real | [EKS](docs/server/eks.md) · [ECS](docs/server/ecs.md) · [GKE / AKS](docs/server/gke-aks.md) · [sizing](docs/server/sizing.md) |
| Connect your sign-in | [Single sign-on](docs/server/sso.md) |
| Turn on AI | [AI providers and models](docs/server/ai.md) |
| Connect a warehouse or semantic layer | [Warehouses and live data](docs/server/live-data.md) |
| Define what your data means | [The Data model](docs/semantic-layer/README.md) · [model files in git](docs/server/model-files.md) |
| Limit who sees which rows | [Row-level security](docs/server/row-level-security.md) |
| Share outside the app | [Embedding](docs/server/embedding.md) · [Slack and Teams](docs/server/subscriptions.md) · [email](docs/server/email.md) |
| Look up a setting | [Every environment variable](docs/server/configuration.md) |
| Keep it safe and current | [Backup and restore](docs/server/backup-restore.md) · [upgrades](docs/server/upgrade.md) · [monitoring](docs/server/monitoring.md) · [audit log](docs/server/audit-retention.md) |
| Automate it | [The MCP endpoint and commands](docs/automation.md) |
| Understand the code | [AGENTS.md](AGENTS.md) · [all docs](docs/README.md) |

<details>
<summary><b>🛠️ How it's built</b></summary>
<br/>

```mermaid
flowchart LR
  B["🌐 Browser<br/>React app"] -- HTTPS --> I["Your ingress<br/>and TLS"]
  I --> O["Ordinate pods<br/>stateless · Node + Fastify<br/>DuckDB per org"]
  O --> PG[("Postgres<br/>users · roles · records<br/>jobs · audit · secrets")]
  O --> S3[("S3 bucket or volume<br/>Parquet tables")]
  O -. "read-only" .-> W["Your databases, warehouses<br/>and semantic layers"]
  O -. "optional" .-> M["AI provider<br/>you choose"]
```

| Layer | What it is |
|---|---|
| **Server** | Node 24 and Fastify 5. Every endpoint is a typed RPC call with a validated input and a role check. |
| **Web app** | React 19, Vite, React Router, TanStack Query and Radix, styled with CSS Modules. |
| **Metadata** | Postgres: users, orgs, roles, records with row-level security per org, jobs, audit log and encrypted secrets. |
| **Tables** | Parquet on a volume or S3, queried in place by DuckDB, one locked worker per org. Live datasets are answered by your warehouse or semantic layer. |
| **Live updates and jobs** | Server-sent events, plus a Postgres job queue shared across pods. |
| **Packaging** | One image for amd64 and arm64, a Compose stack, a Helm chart, and Prometheus `/metrics` on its own port. |

Architecture and conventions are in [AGENTS.md](AGENTS.md). The decisions and the measurements
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

[MIT](LICENSE) © Ordinate contributors · Made by [Ashish Beerelli](https://ashishbeerelli.com)

<sub><b>Open source.</b> <b>Self-hosted.</b> <b>AI-powered.</b></sub>

</div>
