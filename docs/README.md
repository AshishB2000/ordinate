# Docs

New here? Start with the [README](../README.md). To run Ordinate, go to the
[operator docs](server/README.md). To work on the code, read [CLAUDE.md](../CLAUDE.md).

## Current

| Where | What it is |
|---|---|
| [`server/`](server/README.md) | **Operator docs** for running Ordinate: Compose quick start, EKS, ECS, GKE/AKS, SSO, every environment variable, sizing, backup and restore, upgrades. |
| [`phase-7-web/`](phase-7-web/) | **Phase 7**, the move from a desktop app to the self-hosted web app: the [plan](phase-7-web/00-plan.md), the [tasks](phase-7-web/01-tasks.md), the [log](phase-7-web/log.md) of every measured decision, the [threat model](phase-7-web/threat-model.md) and the [retro](phase-7-web/99-retro.md). |
| [`ai-models/`](ai-models/00-plan.md) | **AI models**: Admin → AI connects providers and approves the exact models members may use; each member picks one; all of it in Postgres so every pod agrees. Operator walkthrough: [`server/ai.md`](server/ai.md). |
| [`live-data/`](live-data/00-plan.md) | **Live data**: Snowflake and BigQuery, Live warehouse datasets with a cache age, fresh-on-ask for copies, dashboards that update themselves, and a refresh URL for dbt/Airflow. The [plan](live-data/00-plan.md) and the [log](live-data/log.md) of what was built and measured. Operator guide: [`server/live-data.md`](server/live-data.md). |
| [`rebuild-from-screenshot/`](rebuild-from-screenshot/00-design.md) | **Rebuild a dashboard from a screenshot** of Tableau / Power BI / Looker / Metabase: the model reads the layout only, app code matches its fields to your columns, the engine fills every figure. |
| [`embed/`](embed/00-design.md) | **Signed embedding**: a published dashboard inside another site's iframe, by a link the host's backend signs (HS256), with locked filters enforced in the data path and per-org allowed sites. Operator guide: [`server/embedding.md`](server/embedding.md). |
| [`record-locks/`](record-locks/00-design.md) | **Record locks**: one locked read-modify-write for records (`recordFs.locked`), across pods — an advisory lock in a pinned Postgres transaction — and what each store, the alert evaluator, the org settings and published sites do with it. |
| [`dashboard-filters/`](dashboard-filters/00-design.md) | **Dashboard filters on real data, and saved views**: a searchable value picker that reaches past the first 200 values, date controls named by the server, and shared saved views — a Views menu, `?view=` links, ⌘K, the phone, `/p/`. |
| [`first-run-pass/`](first-run-pass/findings.md) | **The first-run pass**: a fresh install walked as an admin, an editor and a viewer; what was rough, what fixed it, and what is still open. |
| [`analysis/`](analysis/00-model.md) | The analysis and dashboard record model (an analysis is the authoring surface; a dashboard is a by-value snapshot) and the authoring surface. Still the spec. |
| [`automation.md`](automation.md) | The MCP endpoint and the command registry. Generated from `src/automation/registry.ts`; do not edit by hand. |
| [`chart-figures/`](chart-figures/00-design.md) | **One set of figures**: a waterfall's levels, a Pareto's order and cumulative share, a 100%-stacked chart's shares (and a histogram's bins, a funnel's and bullet's percentages, a calendar's days) computed once on the server and drawn by the app, its captions, `/p/` and embeds alike; the published page brought level with the app. |
| [`edit-conflicts/`](edit-conflicts/00-design.md) | **Edit conflicts**: every whole-document editor saves with a content tag, compared inside the record lock; a stale save is refused with a banner (Reload, or Save mine as a copy), and an open editor hears of another save at once. |
| [`email/`](email/00-design.md) | **Email for subscriptions and alerts**: an email list of the org's people and teams, resolved at each send to those who can read the project then; our own SMTP client (TLS required, the operator's one relay); `deliver(channel, source)`, the one send door, which computes the datasets a send's figures come from. Operator guide: [`server/email.md`](server/email.md). |
| [`notifications/`](notifications/00-design.md) | **Notifications that reach the right person**: each member's own alert inbox (`alert_inbox`, 0020), one send path for fired alerts on every path with at-most-once posts (`alert_posts`), a policy dashboard's scheduled run refused before computing, and @mentions in comments — the picker over current readers, the push, the email (budget kind `mention`) and Home's "Mentioned you". |
| [`explore/`](explore/00-design.md) | **Explore**: a question builder for everyone, no AI model needed — the fields of a dataset, a question in four wells, suggested questions from `starterPlan`'s ranking (`explore:suggest`), the answer and its table from `visual:data`, the question in the URL. |
| [`any-pod/`](any-pod/00-design.md) | **Any pod serves any request**: file tokens and staged imports in Postgres with their bytes in the org's staging area, plan runs as records, jobs listed and cancelled across pods, one shared counter for the abuse limits — no sticky sessions. The design, the caller inventory, the refutation folded in, and the two-pod suite `test-anyPod`. |
| [`pod-lifecycle/`](pod-lifecycle/00-design.md) | **A pod that stops cleanly, holds bounded memory, and shows what saturates**: one deadline-bound shutdown (drain, cancel, interrupt, close every DuckDB worker through its queue); bundle, backup and restore read from the file, hostile zips refused before a byte is inflated; the saturation metrics and alerts; one logger. Operator guide: [`server/monitoring.md`](server/monitoring.md). |
| [`sso-lifecycle/`](sso-lifecycle/00-design.md) | **The identity provider decides who gets in**: IdP groups mapped to org roles and teams, applied at each OIDC sign-in and each header change; API tokens that expire; disable that revokes tokens and closes event streams on every pod; row-derived chart labels kept from restricted viewers. Operator guide: [`server/sso.md`](server/sso.md#groups-roles-and-teams-from-the-idp). |
| [`row-policy/`](row-policy/00-design.md) | **Row access rules**: a viewer sees only their rows of a dataset, enforced at the figure doors with a storage net behind them; every read channel inventoried; fan-out refused in phase 1. Operator guide: [`server/row-level-security.md`](server/row-level-security.md). |
| [`dashboard-shapes/`](dashboard-shapes/00-design.md) | **Dashboard shapes**: Scorecard, Review, Visual analysis and Table as one registry the wizard offers and the Assistant's draft builds from; the takeaway under the title is the app's caption of the lead chart; KPI trends, accent + muted charts, a sortable table with bars; the published page full width, with sentence-case titles and one filter per control. |
| [`design-floor/`](design-floor/00-design.md) | **The design floor**: secondary text and every Badge tone at WCAG AA in both themes and every dashboard preset, measured by one test; one page header (a crumb to the parent, chips, actions with one primary) on every page, with a guard against hand-built back links; the doors to databases, URLs and the dashboard wizard; the nav grouped into View and Build. |

## History (the desktop era)

These describe the Electron desktop app that Phase 7 replaced. They are kept for the measurements
behind decisions that still stand, such as DuckDB, Parquet, the resident fast paths and the cost
models. Their paths (`renderer/`, `src/main.ts`, `preload/`) and their UI no longer exist.

| Where | What it decided |
|---|---|
| [`phase-0/`](phase-0/README.md) | Audit of the pure modules (parse, formula, transforms, stats, viz data) before the engine work. |
| [`phase-1/`](phase-1/README.md) | DuckDB behind the existing APIs, benchmarked, and why it started disabled. |
| [`phase-2/`](phase-2/README.md), [`phase-2.5/`](phase-2.5/README.md) | Parquet storage, and wiring the engine up. |
| [`phase-3/`](phase-3/README.md), [`phase-3b/`](phase-3b/README.md), [`phase-3c/`](phase-3c/README.md) | Resident queries over Parquet in place, the async bridge, and Mosaic behind a flag (removed at T8.1). |
| [`phase-5/`](phase-5/01-toolchain.md) | The Svelte toolchain spike (removed at T8.1). |
| [`phase-6/`](phase-6/README.md) | Tauri costed and closed. |
| [`RELEASE-NOTES-0.1.0.md`](RELEASE-NOTES-0.1.0.md), [`self-signed-signing.md`](self-signed-signing.md) | The desktop release notes and code-signing notes. |
| [`superpowers/`](superpowers/), [`design/`](design/) and the per-feature folders (`home-redesign/`, `dash-reskin/`, `viz-thumbnails/`, …) | Desktop-era plans, design references and before/after screenshots. |
