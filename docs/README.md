# Docs

## Current

| Where | What it is |
|---|---|
| [`server/`](server/README.md) | **Operator docs** for running Ordinate: Compose quick start, EKS, ECS, GKE/AKS, SSO, every environment variable, sizing, backup and restore, upgrades. |
| [`phase-7-web/`](phase-7-web/) | **Phase 7**, the move from a desktop app to the self-hosted web app: the [plan](phase-7-web/00-plan.md), the [tasks](phase-7-web/01-tasks.md), the [log](phase-7-web/log.md) of every measured decision, the [threat model](phase-7-web/threat-model.md) and the [retro](phase-7-web/99-retro.md). |
| [`ai-models/`](ai-models/00-plan.md) | **AI models**: Admin → AI connects providers and approves the exact models members may use; each member picks one; all of it in Postgres so every pod agrees. Operator walkthrough: [`server/ai.md`](server/ai.md). |
| [`live-data/`](live-data/00-plan.md) | **Live data**, the plan for fresh numbers: Snowflake and BigQuery, Live warehouse datasets with a cache age, fresh-on-ask for copies, dashboards that update themselves, and a refresh URL for dbt/Airflow. |
| [`analysis/`](analysis/00-model.md) | The analysis and dashboard record model (an analysis is the authoring surface; a dashboard is a by-value snapshot) and the authoring surface. Still the spec. |
| [`automation.md`](automation.md) | The MCP endpoint and the command registry. Generated from `src/automation/registry.ts`; do not edit by hand. |

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
