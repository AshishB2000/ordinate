# First-run pass: findings

Walked on 2026-10-10 against `develop` @ f7cecc3: the built server, a fresh Postgres, the default
password sign-in. Three people: an org admin (created with the setup code), an editor and a viewer
(added in Admin → People with temporary passwords, then given a role on the project).

What worked and needed nothing: the setup-code page, sign-in, the forced password change for a new
member, Admin → People, project sharing, file import and the composer, the visual builder, the
create-dashboard wizard, Admin → AI's not-set-up states, the admins-only page for a non-admin.

## Findings

| # | Severity | Finding | Fixed by |
|---|---|---|---|
| F1 | High | **A fresh install was empty.** No project and no sample data: `seedSampleProject()` was only called by tests and `web/e2e/seed.ts`, never by the server, since the desktop app was deleted. | `sample:seed` (#256) and the **Start with sample data** button on every no-project state. Measured on a fresh install: the sample project built and its dashboard open in 1.3 s. |
| F2 | High | **A viewer saw every edit control, and a refused change was silent.** The server refused correctly (403), but adding a text card as a viewer showed no message at all. | The view-only change: screens gate on `useCanEdit`, the analysis editor opens read-only, and any refused write shows one toast. |
| F3 | Medium | **Home's four Connect buttons all went to the Data list**, and so did "Bring in some data". | Each goes to its own import source or to Connections. |
| F4 | Medium | **With no project, every page was a dead end**: "Create one from Home", and Home had no create control. | One shared no-project state with **New project** (the switcher's dialog), or "Nothing has been shared with you yet" for someone who may not create one. |
| F5 | Medium | **Explore pointed at the deleted desktop app.** | It says Explore is not in the web app yet and links to Home's ask bar and the SQL workbench. |
| F6 | Medium | **KPI tile titles were cut to two letters** ("Re…") at 1280 px, because the "As of" caption shared the header. | The caption gives way first and hides under 300 px of tile head. |
| F7 | Low | **The New project dialog's input was clipped** at the bottom edge. | The dialog body no longer clips the focus ring, and the input no longer draws a second one. |
| F8 | Medium | **The first publish of a dashboard took 35 s** on a spinner. Each tile × filter combination re-read the same records (one Postgres transaction each) and re-hydrated the same table. | `recordFs.withReadMemo` (#257). 8 tiles × 156 combinations, 5,000 rows: 35 s → 4.7 s cold, 2.7–9.4 s → 0.3 s warm, 9,438 → 229 transactions. |
| F9 | Low | **Wrong nouns in the no-project states**: Analyses said "Dashboards belong to a project". | The shared state takes each page's own sentence. |
| F10 | Low | On a Live dataset, a scorecard row shows "n/a" with no reason when its warehouse call fails. | Separate change. |
| F11 | Low | On a Live dataset, a dashboard dropdown over a column with no sampled values answers 409 until Sync schema. | Separate change. |
| F12 | High (multi-pod) | **An org's settings were a file on each pod's disk.** Formats, branding, starred items and first-run guidance were `config.json` under `DATA_DIR`, which with S3 storage is a pod's own scratch disk: pods disagreed, and a restarted pod lost them. | `org_config` (0014) through `src/server/orgConfig.ts`. |
| F13 | — | `npm run build:web` failed on macOS: `ui/AsOf.tsx` and `ui/asOf.ts` differ only by case. | Renamed to `asOfView.ts` (#251). |

## Still open

- **Logos and dashboard images are files on a pod's disk** (`branding/` and `projects/<id>/assets/`
  under `DATA_DIR`). With S3 storage and the chart's `emptyDir` they have the same problem F12 had:
  per pod, and gone after a restart. Not fixed here.
- **Viewer gating is not complete below the top-level screens**: the dataset Details drawer, the
  Quality / Columns / Snapshots sub-tabs, Prepare and Import reached by URL, story and scorecard
  detail pages, the analytics workbenches, Metrics and input tables still show their controls to a
  viewer. A click there now gets the view-only toast instead of silence.
- **`sample:seed`'s in-flight guard is per pod**: two admins on two pods clicking in the same second
  would make two sample projects.
- **Two pods changing settings in the same second**: the later write wins, for the whole document.
- A project editor refused a project-admin action gets no toast (the safety net covers `write`
  channels only).
