# Changelog

All notable changes to Ordinate are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning per
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** the project was renamed from **Screenchart** to **Ordinate**. Releases up to and
> including 0.1.0 shipped under the Screenchart name; entries below use the current name.

## [Unreleased]

### Notifications that reach the right person

- **Your own alert inbox.** The bell's badge counts the alerts *you* have not seen in the project; every
  reader (viewers too) has Mark seen and Mark all seen, which clear your badge only. Snooze stays an
  editor's and says so: "Snooze for everyone · 24 h". Nobody's badge lights up on upgrade (migration
  0020, `alert_inbox`). A page that leaves the app (publish, embed, a report) names alerts by the data,
  never by one person's inbox.
- **One alert send path.** A rule's Slack / Teams / email channels now get its post however it fired —
  a ↻, an input-table save, a snapshot restore, fresh on ask, a refresh URL, a pipeline's alert step —
  not only on the schedule, and each event at most once across paths and pods (`alert_posts`).
- **A scheduled send of a dashboard with row access rules computes nothing**: it is skipped as
  `row_policy` before any figure is resolved.
- **@mentions in comments.** Typing @ lists up to 8 people who can read the project now; a mention shows
  as "@Name" (or "@former member" once they lost access); anyone else is refused. The person gets a
  notice in their open tabs with Open, an email (Settings → You → "Email me when someone mentions me",
  on by default; budget kind `mention`, audited per recipient) and a row in Home's new "Mentioned you".
  Off without a database. See `docs/notifications/00-design.md`.

### Breaking — Ordinate is now a self-hosted web app (Phase 7)

The Electron desktop app is gone. Ordinate is a server a company runs in its own infrastructure,
and people use it in a browser. The plan, every measurement and the retro are in
[`docs/phase-7-web/`](docs/phase-7-web/); operator docs are in [`docs/server/`](docs/server/).

- **Server:** Node 24 and Fastify 5 (`npm run server`). Every endpoint is an RPC channel with a zod
  contract and a role check: a channel with no contract does not exist. Push is server-sent events.
- **Web app:** the whole UI was rewritten in React 19 with Vite. The desktop screens were ported
  with a parity checklist (each dropped control named, with its reason), from Home through Data, Prepare, Pipelines, Visuals, Analytics, Analyses,
  Dashboards, Reports, Settings and Admin. A command palette replaces the native menus.
- **Sign-in and roles:** OIDC (Okta, Entra ID, Google, Keycloak, Auth0) or a trusted sign-in proxy
  in header mode. Orgs, teams, per-project roles (viewer, editor, admin), sharing, an audit log,
  personal API tokens and an admin console.
- **Storage:** metadata in Postgres (row-level security per org); Parquet tables on a volume or on S3
  through DuckDB `httpfs`; connection passwords and AI keys under envelope encryption with
  `ORDINATE_MASTER_KEY`. `npm run import-desktop` brings a desktop install's projects across.
- **Engine:** one locked DuckDB worker per org, no blocking call on the request thread, user regex in
  a worker with a 2 s deadline, jobs and events shared across pods through Postgres.
- **Security:** SSRF guard on every connector, CSRF protection, a strict CSP header, rate limits,
  request timeouts, a written threat model and `SECURITY.md`. Eight review findings (F1–F8) were
  fixed with regression tests.
- **Publishing:** a dashboard publishes to `/p/<id>`, visible to org members, or to anyone with the
  link if an admin turns public links on.
- **Automation:** the MCP endpoint `POST /api/mcp`, signed in with an API token. The desktop's
  `--cli` and stdio MCP have no entry point any more.
- **Packaging:** one container image for amd64 and arm64 (under 600 MB, downloads nothing at run
  time), a Docker Compose stack, a Helm chart and a tag-driven release workflow. `/metrics` serves
  Prometheus on its own port.

**Removed with the desktop app:** the screenshot hotkey and overlay (a screenshot is now uploaded),
local CLI model execution, the local-folder connectors (DuckDB file, Parquet folder, CSV folder),
folder watch, the sync folder, OS menus and notifications, the Mosaic renderer, the Svelte spike and
the desktop installers.

### Added — since the move to the web

- **Live datasets.** A warehouse table can stay **Live**: charts, KPI tiles, AI answers, alerts and
  scorecards ask the warehouse itself, through SQL Ordinate compiles, and cache the answer for the
  cache age you choose (from always live to 1 day, 5 minutes by default). Offered on Snowflake,
  BigQuery, Redshift, Databricks SQL, ClickHouse, and a PostgreSQL connection marked as a read
  replica. Every figure says how fresh it is (*As of*, *Live*, or *Stale*). Tools that read rows are
  off on a Live dataset and offer **Make a copy**. A parity test proves a Live answer and a copy's
  answer agree. See [`docs/server/live-data.md`](docs/server/live-data.md).
- **Snowflake and Google BigQuery connectors**, taking the catalog to 40 read-only sources.
- **Warehouse cost controls.** A daily query limit per org, a concurrency limit, a query timeout, a
  BigQuery bytes-billed cap, and **Admin → Live usage** showing queries and billed bytes per
  connection.
- **Fresher copies.** Open dashboards update by themselves after a refresh, every tile says how
  fresh it is, a copy can refresh every 5 minutes or pull only its new rows when someone asks
  ("fresh on ask"), and a refresh URL lets dbt or Airflow say when new data has landed.
- **Admin → AI.** An admin connects each AI provider once and approves the exact models members may
  use, with one default. Members pick a model from that list and never see a key. The setup moved
  from a file on each pod to Postgres, so every pod agrees. The "Connect a provider" form is gone
  from the Assistant. See [`docs/server/ai.md`](docs/server/ai.md).
- **Password sign-in for trying Ordinate out**, now the default. The server prints a one-time setup
  code at first start; you create the admin account in the browser and add people with temporary
  passwords. Switch to single sign-on before real use. See [`docs/server/sso.md`](docs/server/sso.md).
- **Dashboard filters that reach every value, and saved views.** A dropdown or multi-select control
  is a searchable popover: it says how many values there are past the first 200 and finds any of
  them by searching on the server; over a Live dataset it names the sample and takes a typed value.
  A date control is the period picker, named by the server ("Last 30 days"). The **Views** menu
  saves what is on screen as a shared view (editors), and everyone can apply one or copy its link
  (`?view=`); ⌘K opens a view in place, a phone picks one in its Filters sheet, and a published
  page offers it. See [`docs/dashboard-filters/`](docs/dashboard-filters/00-design.md).
- **Explore: ask a question with no AI model.** Explore is a full-width question builder for
  everyone, viewers included: pick a dataset, then a measure and its aggregate, what to group by
  (and a date's grain), a split and filters — or start from a suggested question, each with a live
  thumbnail. The answer is the server's chart and the same answer as a table; the question lives in
  the URL, so Copy link shares it and Back undoes an edit. Editors can save it as a visual or open it
  in the builder. With an AI model set up, an ask box hands plain words to the Assistant. See
  [`docs/explore/`](docs/explore/00-design.md).
- **Email for subscriptions and alerts.** An org admin makes an email list in Admin → Channels from
  the organization's people and teams (no typed addresses); a subscription or an alert sent to it
  reaches only those of them who can open the dashboard's project at that moment, through the one SMTP
  relay the operator configures (`SMTP_HOST`, `SMTP_FROM`; TLS required, `plaintext` only to a private
  relay). The subscription preview has an Email tab; **Send a test email** goes to the admin alone.
  **Send now** is limited to once a minute per subscription, for every channel kind.
  See [`docs/server/email.md`](docs/server/email.md).

- **Row access rules.** A project admin can limit what each project viewer sees in a dataset to the rows whose chosen column holds their values — by person or by team — from the dataset's new **Row access** tab. Every chart, KPI, answer, data grid, filter list and column panel then shows that viewer only their rows; readers that work over the whole table (SQL, statistics, drivers, segments, insights, quality results, snapshot diffs, Prepare previews, exports) are refused with a sentence that says why, and published links, embeds, subscriptions and alerts are off for such a dataset. Live datasets bind and byte-compare the rule's values on every warehouse. See [`docs/server/row-level-security.md`](docs/server/row-level-security.md).
- **One page header, the missing doors and a grouped nav.** Every detail page has the same header:
  a crumb back to its parent above the title, chips after it, its actions on the right with at most
  one primary. The analytics workbenches' "Close" is now a crumb back to where you opened them from
  (a dataset, a dashboard, the Analytics hub). Data → Import lists **Database, warehouse or app** and
  **From a URL**, the Data header and its empty state offer **Connect a database**, and Home → New →
  Dashboard and the Dashboards page's new **Create dashboard** open the new-dashboard wizard (all for
  editors). The rail groups its sections under **View** and **Build**. See
  [`docs/design-floor/`](docs/design-floor/00-design.md).

- **What saturates, on `/metrics`.** The DuckDB queues (depth, busy workers, wait), the Postgres
  pool (open, idle, waiting), event-loop delay, memory, open event streams, Live queries in flight
  and whether the pod is draining — never by org. `DATABASE_POOL_MAX` sizes the Postgres pool (10
  by default). The Helm chart can ship a ServiceMonitor and six alert rules
  (`metrics.serviceMonitor.enabled`, `metrics.prometheusRule.enabled`, both off). See
  [`docs/server/monitoring.md`](docs/server/monitoring.md).

### Added — identity provider groups, token expiry, disable that sticks

- **Roles and teams from your identity provider.** Set `OIDC_GROUPS_CLAIM` (OIDC) or
  `TRUSTED_GROUPS_HEADER` (header mode), then map groups to an org role and to teams in Admin → People
  → Identity provider groups. Applied at every sign-in (header mode: whenever the groups change); a
  missing claim, a malformed one or Entra ID's group overage changes nothing; the org's last admin is
  kept. Once a group maps a role, roles are no longer set by hand, and a linked team's members come
  from the IdP. `OIDC_EXTRA_SCOPES` asks for scopes an IdP needs to send groups. Migration 0019.
- **API tokens expire.** A new token lives 30, 90 or 365 days, up to `API_TOKEN_MAX_DAYS` (default
  365); the API tokens page shows each token's end.
- **Disabling someone closes their open tabs' event streams on every pod**, within a second, as do
  signing out everywhere and a password reset.

### Changed — identity provider groups, token expiry, disable that sticks

- **Tokens made before this release now expire `API_TOKEN_MAX_DAYS` after they were made** (365 days
  by default); one older than that stops working at once. Lowering the maximum shortens every token.
  `tokens:create` now requires `expiresInDays`.
- **Disabling someone revokes their API tokens for good**: enabling them again no longer brings a token
  back.
- **The last-admin rule counts only admins who have signed in**: an invited admin who has not signed in
  yet no longer lets the last signed-in admin be demoted or disabled.

### Security — since the move to the web

- **SQL over datasets is checked against DuckDB's own reading of the query.** A query could reach
  another project's data in the same org through SUMMARIZE, DESCRIBE, PIVOT and similar words, or
  read the engine's own catalog. Stored SQL datasets and notebook cells that use PIVOT without `IN`,
  a catalog view, or a table function other than `range`, `generate_series`, `unnest`,
  `json_each`, `json_tree`, `repeat` and `repeat_row` are now refused, so their refresh will fail:
  list the PIVOT values (`ON col IN (…)`) or query the project's datasets instead.

- **`projects:list` and `projects:open` no longer return a project's colour map or its dismissed
  insight ids** (either can name a value from the data). The colour map is read with
  `format:colors:get`, as the app already does. A subscription or alert over a dataset with row access
  rules now records the run code `row_policy`.

- **Embeds refuse more datasets that store values computed across rows.** A locked embed tile is now refused when its dataset was built by SQL, a notebook or the composer, when a step looks up another dataset, or when a group-by, pivot or keyed dedupe does not keep every locked column — each could carry another customer's rows or totals into the view. (The same rule backs row access rules.)

- **A restricted viewer no longer receives a related dataset's rows through a cached chart or KPI.** A chart or
  KPI on a dataset without row access rules whose question reached a related dataset with rules was
  answered from the answer cache an editor had warmed, labels and figures included. It is now refused
  (`related`) before the cache is asked, and its stored labels are not sent either.

- **Charts no longer send a restricted viewer category labels from other teams' rows.** A waterfall's
  totals, a drivers tile's path and an inline dashboard card's styling are dropped for that viewer on
  every path that returns a visual (as a custom order and series colours already were); the waterfall
  still marks its own totals, filled in by the server from the saved visual. Edit tags returned to that
  viewer are of what they were sent.

- **A bundle or backup upload is checked before a byte is inflated.** Import and restore read the
  file in place and refuse zip64, data descriptors, encryption, unknown methods, names off the
  whitelist (in any case or Unicode form, or twice), lying sizes, overlapping entries and local
  headers that disagree with the directory. A record over 32 MiB is never stored, so no bundle
  Ordinate writes is one it would refuse.

### Fixed — since the move to the web

- **Two saves of one record no longer lose one, on any number of pods.** Comments, alert rules and
  their inbox, catalog notes, currency settings, pipelines, privacy settings, themes, version
  history, dataset metadata, snapshots, input tables, project settings and colours, subscriptions
  and published sites each save under one lock per record, held across pods through Postgres. A
  deleted alert rule no longer comes back when an evaluation that started before the delete
  finishes, and two evaluations at once fire once. A re-publish after a refresh keeps the owner's
  "members only" setting and no longer brings a removed site back. Two pods saving org settings in
  the same second keep both changes. A save that waits more than 15 s says "try again". See
  [`docs/record-locks/00-design.md`](docs/record-locks/00-design.md).
- A new project's first alert rule could appear in the next new project's alerts.
- A dashboard whose prepare steps read a parameter could be served another parameter value's cached figure, and the data search read personal and financial columns when the share-policy lookup failed (F21). A grid request with no page window counted every row instead of the filtered ones.
- **A published Pareto and waterfall showed different figures from the app.** The `/p/` page and
  signed embeds worked them out a third time, differently: a Pareto drawn in arrival order, its
  cumulative line dragged down by negatives, and a waterfall without its Total rows or its
  last-year → this-year bridge. The server now computes a chart's drawn figures once (a waterfall's
  levels, a Pareto's order and cumulative share, 100%-stacked shares — unrounded — a histogram's
  bins, a funnel's and a bullet's percentages, a calendar's days) and the app, its captions, `/p/`
  and embeds all draw them. The published page also reads like the app: "Jan 2023" months, value
  labels, no vertical gridlines, KPI subtitles, and style Auto following the reader's light or dark
  setting. See [`docs/chart-figures/00-design.md`](docs/chart-figures/00-design.md).
- **Two editors never overwrite each other.** Dashboards, visuals, metrics and metric trees, reports,
  stories, scorecards and scenarios were last-writer-wins: two people on one dashboard, or one person
  in two tabs, silently overwrote each other's work. Each editor now saves with a tag of the content
  it opened; a save from a copy someone else has since changed is refused, and a banner offers
  "Reload" or "Save mine as a copy" instead of overwriting. An open editor also learns at once when
  another save lands. Saving a view, starring a visual, generating a report or scheduling it never
  counts as a change. API and MCP callers that send no tag keep last-writer-wins. Version history now also keeps
  a dashboard parameter's saved default, a visual's analytics overlays, and a report's discussion page
  and view, and a restore puts them back. See
  [`docs/edit-conflicts/00-design.md`](docs/edit-conflicts/00-design.md).
- **Secondary text meets WCAG AA in both themes.** Table headers, KPI names and deltas, timestamps,
  empty-state sentences and placeholders were as low as 1.7:1. The muted, dim and faint text colours
  take the desktop's AA values (4.5:1 on every surface; faint, 3:1, is kept for disabled controls
  and decorative icons), every Badge tone and grid type chip has an ink that reads on its own tint,
  and the dashboard style presets follow. A workspace or dashboard brand accent's text colour and a
  custom theme's (including one saved earlier) are worked out for their own light or dark surfaces
  the same way, and the theme editor warns about an ink that does not read. A test measures every
  pair, so it cannot regress.
- **Any pod serves any request: no sticky sessions.** The chart's default of 2 replicas failed at
  random: an upload, its parse and its save, an export and its download, a backup and its restore, or
  an Assistant plan's steps landing on different pods. These now work on any pod:
  - upload and download tokens are rows in Postgres (their sha256 only), and their bytes sit in the
    org's staging area (the shared `DATA_DIR`, or `orgs/<org>/staging/` on S3);
  - a staged import is a Parquet file any pod saves;
  - an Assistant plan run is a record;
  - Cancel and the Jobs list reach every pod;
  - the sample seed and a pipeline run are one at a time across pods (a pod runs at most two
    pipelines at once; a third waits for a slot).

  The password lockout, the email budgets, Send now and the embed limits now count across pods, so
  N pods no longer allow N times each limit. See [`docs/any-pod/00-design.md`](docs/any-pod/00-design.md).
  - **Changed:** an email budget's hour now starts at its first email rather than rolling, so up to
    twice the limit can go out in the minutes around its end.
  - **Changed:** each password attempt is charged before it is checked, so at most 10 are ever
    checked in 15 minutes.
  - **Changed:** the `plan:*` RPCs take `projectId`.

- **A rolling deploy stops a pod cleanly.** On SIGTERM the pod answers `/readyz` 503, refuses new
  jobs ("Ordinate is restarting. Try again in a minute."), lets running jobs and requests finish,
  cancels what is left at a deadline ("Ordinate restarted while this was running. Run it again."),
  interrupts every DuckDB query and closes each worker through its own queue, then exits 0 inside
  `SHUTDOWN_GRACE_SECONDS` (20 s). Measured: 0 native aborts in 241 signalled shutdowns; the old
  path aborted 7 times in 100 with a query unwinding and overran in 40 of 40 with one running.
  Compose now waits 30 s before killing. See [`docs/pod-lifecycle/`](docs/pod-lifecycle/00-design.md).
- **A bundle import, a backup or a restore no longer holds the upload, or the org, in memory.**
  Tables stream to disk; records are read one at a time; a backup holds one project at a time and
  a restore runs inside its job. Measured: a 4 MB bundle declaring 4 GiB streams with RSS up 12 MB;
  a 279 MB backup of 16 projects with RSS up at most 107 MB. A cancelled job now also stops the
  DuckDB query it was in.
- **Every server log line is JSON through pino**, with the request id and org inside a request; no
  `console` call is left in `src/` (lint-enforced). The Assistant's screenshot dev dump no longer
  writes extracted cells to the log.

### Added
- **The app is no longer empty on first launch.** A bundled sample project — 5,000 rows of generated
  retail orders across two years, five regions and twenty-five US states — arrives with a dashboard
  already built: revenue, profit, units and order-count KPIs, revenue by month, revenue by category,
  and a profit-by-state map. It is pinned to Home, so Starred and Recent have something in them, and
  the ask bar suggests questions written for it. The data is generated, not real; there is a planted
  bad month for anomaly detection to find. A **Delete sample project** button on its notes card
  removes it completely, and it is never re-created afterwards. Your own work goes into a separate
  empty project that is selected by default, so the sample never collects it.

- **Dashboard starter layouts that actually build something.** "KPIs + chart" and "Two-up" used to
  drop in a note reading *"Add metric cards here"* and then ask which already-saved visual belonged
  in the slot — on a new project that meant one text card. They now build real tiles from the
  dataset you pick: a KPI row totalling its numeric columns (revenue/sales/amount and friends
  first), a chart over the first column narrow enough to read as an axis, and, when there is a date
  column, the same measure by month. Both the empty-state buttons and the create-a-dashboard wizard
  use them, and the tiles are made by the same code path the Assistant's dashboards go through.

### Changed
- **New tiles fill the row.** Adding a visual, metric, control or note now drops it in the first
  free space on the grid instead of always starting a new row in column 0 — four KPIs sit in one
  row, and notes run the full width.
- **Drag and resize are visible.** Dashboard tiles could always be dragged to move and dragged by
  their right/bottom edge to resize; the handles simply drew nothing. They now appear on hover, and
  the tile header shows a grip. Narrow windows put one tile per row.
- **Present mode fills the window.** It hides both rails and the page tabs (it hid neither before —
  the rule named an element that is not the rail), and scales the tiles so the sheet fills the
  screen instead of leaving a band of empty background below the last row.
- **Chart controls left the plot.** The "Values" and "⋯" buttons moved out of the top-right of the
  chart — where they covered its own data labels — into the tile header and the visual builder's
  toolbar. Maps keep their existing overlay.

- **Change a dashboard by asking.** With a dashboard open, tell the Assistant what you want —
  "add a line chart of amount by month", "make the region chart a bar", "add a filter for channel",
  "rename page 1 to Overview" — and it proposes the change as a plain diff: what it would add,
  change and remove, with a real preview of any new tile and a list of anything it refused. Nothing
  moves until you press Apply, and one Undo puts the whole thing back, including the charts it
  retyped and any it created. It names tiles by their titles, and refuses rather than guessing when
  a name could mean two of them.
- **Dashboard styles — pick how a dashboard looks.** Four app-owned presets: **Clean** (the look
  that shipped), **Executive** (muted paper palette, serif KPI figures, cards that lift off the
  page), **Dense** (tighter grid and smaller type) and **Dark** (dark surface, same accent). Choose
  one from **Style…** in a dashboard's ⋯ menu — four live thumbnails of *your* grid, previewed
  instantly and undoable until you Apply — or before you build, from the strip on the Assistant's
  dashboard proposal. The Assistant understands "make it dark", "make it denser" and "executive
  style", and hands you the same one-click confirm. A style travels with the dashboard: it is saved
  on the record and carried into shared HTML, PDF and PNG exports, so a snapshot looks like what its
  author saw. Charts re-skin with the sheet. Nothing moves: every preset keeps the same twelve
  columns, so a restyle never repositions a card. The Assistant only ever names one of the four
  presets — it never writes CSS or picks a colour.
- **Ask the Assistant to build you a dashboard.** Say "build me a sales dashboard for Adidas US
  Sales" in the Assistant or the Home ask bar and you get a proposal you can look at — its name, why
  it was proposed, each chart drawn with your real numbers, and a plain list of anything the app
  refused to accept — with **Build dashboard** and **Adjust…** underneath. Follow-ups refine the same
  proposal rather than starting over. Every figure in it is computed by Ordinate; the Assistant only
  proposes the structure, and anything it gets wrong is shown to you rather than quietly dropped. An
  empty Dashboards page now suggests build requests over the datasets you actually have.
- **Explore — ask a question about your data.** A page of its own, above Home and on the Home
  screen: pick a dataset, ask in plain language, and get an answer built from figures the app
  computed — with chips saying which dataset and columns they came from. Where the question suits
  one, a real chart appears under the answer, drawn from the app's own numbers and saveable as a
  visual or added straight to an analysis. Conversations are kept per project, so you can leave one
  and come back to it, and start a fresh one whenever. The old Copilot panel is gone; this replaces
  it, and everything still works with no model connected — the AI on/off switch came with it.
- **Dashboards can carry live filter controls.** Add a dropdown, multi-select or date-range card and
  every other card on the sheet filters along with it — no editing, no republish. A reader's picks
  live only in the open window: they are never written to the saved dashboard, so two people looking
  at the same published dashboard can filter it differently without either one moving the file the
  other is looking at. Controls work on a published, read-only dashboard exactly as they do on a
  draft, and stay usable in Present mode — filtering is a read, same as drilling into a chart already
  was. An author can set a control's default from the dialog or by trying it on the sheet and saving
  the current pick; a reader can always get back to that default with the sheet's **Reset controls**
  button, which appears only once a control has moved off it. Drill-down chips and the exported
  summary both reflect a control's current selection; the export itself never carries a live widget,
  only the plain-text value it was set to.
- **Datasets can refresh themselves.** Set a dataset to re-fetch Hourly, Daily or Weekly and Ordinate
  keeps it current. It is honest about what that means: schedules run while Ordinate is open, and
  anything that came due while it was closed catches up when the app launches — the setting says so.
  A master toggle in Settings turns the whole thing off.
- **The app tells you when something changed or broke.** A failed refresh notifies you with the
  reason; a row count that moves more than ±20% notifies you with both numbers. A refresh that went
  as expected stays silent — the `Data as of` line already says it happened, and it updates in place
  without the list jumping under you.
- **Watch a dataset for anomalies.** Turn it on beside the schedule and Ordinate tells you when a
  refresh brings *new* anomalies — never the same ones twice, and never one that has been resolved
  and come back unnoticed. The count is computed by the app; no model is involved anywhere in this
  path. Explaining an anomaly with AI is still something you ask for.
- **The sidebar's search box works.** It always promised "datasets, analyses, dashboards and
  connectors" and did nothing at all. Type and it finds them by name — plus visuals — with arrow
  keys, Enter to open, and Escape to dismiss. It searches names, not row contents.
- **Creating a dataset is a page, not a dialog.** Picking any source opens the **composer**: the
  tables you are combining sit on a canvas with visible join links, the result previews live
  underneath, and the preview's own header row is where you rename, retype and drop columns. Import
  is now: pick a source → composer → Save.
- **Combine as many tables as you like**, not two. Drag or click a saved dataset onto the canvas to
  chain it on; each link has its own join type and key pair.
- **Left joins.** A join can now keep every row on the left and leave blanks where there is no
  match, instead of only keeping rows that match on both sides. Click a join badge to switch between
  Inner, Left and Append and watch the row count change.
- **Field mapping is reversible.** Renames and drops land as ordinary prepare steps, so a composed
  dataset opens in the explorer with its pipeline visible and every mapping removable — exactly like
  a step added later. A dropped column collapses to a restore stub rather than vanishing.
- **A composed dataset refreshes.** Re-fetching it refreshes every table it was built from and
  re-runs the combination over the fresh rows, keeping your prepare pipeline. If one of those tables
  has been deleted it refuses, says which, and leaves the stored data exactly as it was.
- **See the rows behind any number.** Click a bar, a slice or a point — or pick
  `⋯ → Show underlying rows` on any visual — and a panel slides over showing exactly the rows that
  produced it, paged, searchable and sortable. The filters that define the set are listed as chips,
  so you can see what you are looking at. Search and paging run against the stored data, so this
  works the same on a million rows as on a hundred. Available everywhere a visual renders, including
  a published, read-only dashboard: drilling only ever reads.
- **When the exact rows cannot be identified, the panel says so.** A map region, a chart that plots
  raw rows rather than groups, a category that is not a stored column, or a mark with a blank label
  (a missing value and an empty one are different rows) all get a plain sentence explaining why
  instead of an approximate row set that would quietly contradict the figure above it.
- **Export the drilled rows to CSV** — exactly the set on screen, with the same filters, search and
  sort. Plain RFC-4180 text, written straight to the file you pick.
- **Datasets can be refreshed.** A CSV, an Excel sheet, a URL, a database connection and a combined
  dataset can all be re-fetched from where they came from — not just connections, as before. A
  refresh keeps your prepare pipeline: the fresh rows become the new source and every step is
  re-applied.
- **Every dataset says how old its data is.** The Data section shows `Data as of <time>` per dataset
  with a `↻ Refresh` button, plus `Refresh all`. A dataset with no re-fetchable source (pasted text,
  a screenshot capture, or anything imported before this release) says `Imported <time>` and
  explains that re-importing the file makes it refreshable.
- **Analyses and published dashboards show their data's age** in the header, taken from the *oldest*
  of the datasets they read — a sheet is only as fresh as its stalest input — with a
  `↻ Refresh data` action that refreshes exactly those datasets and redraws.
- **A failed refresh never touches your data.** If the file has moved or the source is unreachable,
  the stored table is left exactly as it was, the reason is shown inline next to the dataset, and a
  warning dot stays until the next successful refresh.
- **Visuals is a gallery.** Saved visuals are cards showing the chart type, name and last-updated
  time, instead of a list of rows. Each card has a star and a `⋯` menu: Open, Rename, Duplicate,
  Add to analysis, Export, Delete.
- **Favourite a visual** to pin it to the front of the gallery.
- **Export a single visual** on its own — PDF, PPTX, DOCX, HTML or PNG — through the same export
  dialog the capture result surface uses, carrying the styling the builder saved.
- **Add a visual straight to an analysis** from its card, into an existing analysis or a new one,
  without leaving the gallery.
- **"+ New visual" asks first**: which dataset, then whether to describe what you want or open the
  builder yourself.
- **The AI proposes several charts and draws them**, so you pick from real charts instead of
  accepting one sight-unseen. Every figure on screen is computed by the app from your data — the
  model contributes the structure and a short caption, and never a number. Nothing is saved for
  you: picking one opens the builder, and you still review and save it.

### Changed
- **Adding to an analysis is one dialog, not a chain.** A metric used to be four modals in a row
  (dataset → column → aggregation → label); it is now a single form with a **live preview of the
  number** the card will show, computed by the app exactly as the card computes it. Adding a visual
  is a gallery of your saved visuals rather than a list of names — and it carries `+ New visual` and
  `✨ Suggest with AI`, so you can make one **without leaving the analysis**. With nothing saved yet,
  those two are the whole dialog: no more dead end.
- **Selecting a card opens its Properties.** Editing the card is why you clicked it. Deselecting
  (Escape, or a click on empty canvas) closes the panel again — unless you opened it yourself from
  the rail, in which case it stays. The field list no longer moves between panels: it lives beside
  the wells, and the Data panel has its own browse copy.
- **An empty sheet now says what a sheet is for**, offering Add a visual / Add a metric / Add text
  above the two starter layouts, instead of a blank grid.
- **A selected card shows its outline and controls**; unselected cards show them on hover, so a
  sheet at rest reads as content rather than a wall of buttons.
- **The analysis header shows its publish state as a pill** — Draft, Published, or Unpublished
  changes — instead of hiding it in a tooltip.
- **The Analyses list is painted like the rest of the app**: a proper header with a count and
  right-aligned actions, the shared table treatment, and one status pill carrying all three states
  (it used to say "Published" beside a separate "Unpublished changes" badge).
- **The Data section is three jobs in three places.** It was one scroll of twelve blocks that
  interleaved importing, exploring and preparing, with the saved datasets — the thing the section is
  for — last, under all of it. Now: your datasets are a table at the top (Name, Rows, Source, Data as
  of), importing is a dialog, and opening a dataset takes the whole panel with a `← Back to datasets`,
  the same way the Visuals gallery and builder swap.
- **A dataset's views are tabs: Data, Prepare and Quality.** Quality used to be a strip above the
  toolbar that nobody scrolled to, and says "no quality issues found" when there is nothing to
  report. Prepare is a workbench — the steps on the left, the live grid on the right — so you can
  see what a step does to your data while you edit it.
- **Combine datasets moved out of Prepare** and into its own action in the Data header — and is now
  the composer, not a dialog of four selects. There is one flow for making a dataset, not two.
- **The Visuals builder is a two-pane workbench, not one long scroll.** Building a chart used to mean
  a single column — encoding form above, chart squeezed below it — so seeing what a change drew meant
  scrolling past Category/Measures/Filters first. Now: a header carries Back, the visual's name,
  Dataset, Suggest chart and Save; a fixed-width panel on the left holds the encoding form; and the
  chart fills the stage beside it in its own card, the same head-and-rail shape as the Prepare tab.
- **Internal: the ten biggest source files are split by job**, and a CI check now keeps them that
  way — no source file may exceed 800 lines, against an allowlist that can only shrink. Pure code
  movement, no behaviour change: `hub.ts` 2051 → 422, `dashboards.ts` 2340 → 269, and `authoring`,
  `datasets`, `visuals`, `analyses`, `connections` and `formula` likewise.
- Renamed the project from Screenchart to Ordinate. Screenchart is now the name of one data source
  (screenshot capture) rather than the product. The application bundle and `userData` directory are
  unchanged pending a migration.
- The AI chart suggestion may now propose any of the 25 chart types the app can draw, up from seven.

### Fixed
- The Data section's paste box, sheet picker, warnings, preview, save bar, prepare panel and quality
  strip were on screen permanently — each set a CSS `display`, which overrides the `hidden`
  attribute, so they never went away no matter what the app asked for. Closing an open dataset also
  left it on screen under the list, for the same reason.
- First-run capture no longer shows a redundant "Capture failed" card window before macOS
  Screen Recording permission is granted.
- Multi-step modal dialogs no longer let the keyboard focus trap land on a control in a hidden step,
  which stranded focus outside the dialog.
- A dashboard-level filter and a card-level filter using `in`/`not in` on the same column could
  collide and one would silently drop the other, from a dedup key that ignored the values being
  filtered on. Fixed before it could bite a real user: it only started mattering once a control card
  could itself emit an `in` filter.
- Logos, Image-card pictures and each project's masking key no longer live on one pod's disk. With
  two or more pods (the Helm default) a logo showed on the pod that took the upload and nowhere
  else, and export, import and restore lost pictures. Images are now rows of `blobs` in Postgres
  (migration `0018_blobs`) and the masking key is an encrypted secret. Files an earlier release left
  are copied in on first read ([upgrade notes](docs/server/upgrade.md)).
- **Hash (mask) steps now refuse instead of skipping** when the project's masking key cannot be read
  (a damaged key file, a key store that is down, or the wrong master key). They used to keep the raw
  column and only warn.
- Installs with two or more pods had a different masking key on each pod, so the same value hashed
  differently depending on which pod ran the step. The first pod to read a project's key now stores
  it for all of them, and datasets hashed on the other pods are hashed again under it on their next
  refresh or step change.

## [0.1.0] — 2026-07-XX <!-- TODO(ashish): set release date -->

Initial public release.

### Added
- Global-hotkey capture (default ⌘⌥S, user-configurable): drag a box around any chart, table,
  or on-screen data from any app.
- Plain-English AI analysis of the captured region.
- Visualizations rendered from the captured data.
- Bring-your-own-key providers: Anthropic, OpenAI, Gemini, and gateway (any OpenAI-compatible
  endpoint, e.g. OpenRouter / Ollama / custom).
- Local CLI-agent execution path as an alternative to BYOK.
- Local capture history (`userData/history/<threadId>/`).
- Map visualizations (tiles fetched from OpenStreetMap on render).
- macOS build (packaged with electron-builder).

### Known issues
- Unsigned build → macOS Gatekeeper shows "Apple could not verify" on first launch (see
  QUICKSTART for the dismissal steps).
- Some CLI agents (e.g. Cursor) trigger a macOS Automation prompt that is safe to deny.
- API keys are stored in plaintext on disk (not encrypted) — see PRIVACY.md.

<!-- [Unreleased]: https://github.com/AshishB2000/ordinate/compare/v0.1.0...HEAD
     [0.1.0]: https://github.com/AshishB2000/ordinate/releases/tag/v0.1.0 -->
