# Four-Month Screenchart Expansion Plan

This plan assumes one founder working full-time with AI agents. The outcome is a complete, usable
v1 product across all seven areas—not feature parity with Power BI, which would require a much
larger team and timeline.

The finished experience:

> Bring in data → prepare a dataset → create visuals → assemble a dashboard → analyze it with AI
> → save, export, or share it.

AI remains optional throughout.

## Final v1 Product

### 1. Data Sources

Users can:

- Import CSV, Excel, and JSON files.
- Paste tabular data directly.
- Turn screenshots into datasets.
- Connect common databases.
- Connect to a basic web API.
- Save and reopen connections.
- Refresh imported data.
- See clear connection and import errors.

### 2. Dataset Studio

Users can:

- Preview rows and columns.
- Rename columns.
- Correct data types.
- Filter and sort data.
- Handle empty or invalid values.
- Create calculated fields.
- Group and summarize data.
- Combine related datasets.
- View the steps applied to a dataset.
- Undo or remove transformations.
- Perform these operations manually or through AI.

### 3. Visual Builder

Users can:

- Select a dataset.
- Drag or select fields for a visual.
- Choose among supported chart and map types.
- Change measures, categories, periods, and aggregations.
- Add filters.
- Customize titles, colors, labels, legends, and axes.
- Save and duplicate visualizations.
- Ask AI to recommend or build a visualization.
- Create every visualization without AI.

### 4. Dashboards

Users can:

- Create dashboards from saved visualizations.
- Resize and rearrange visuals.
- Add text, headings, and key metrics.
- Add dashboard-level filters.
- Apply one filter across multiple visuals.
- Create multiple dashboard pages.
- Enter presentation mode.
- Export dashboards.
- Save and reopen dashboard projects.

### 5. AI Copilot

AI appears in two forms:

- A persistent chat panel beside the workspace.
- Contextual AI actions inside datasets, visuals, and dashboards.

Users can ask AI to:

- Explain a dataset.
- Clean or transform data.
- Suggest calculations.
- Create visualizations.
- Draft a dashboard.
- Find trends and anomalies.
- Explain individual visuals.
- Generate an executive summary.
- Suggest follow-up questions.

Before changing data or a dashboard, AI shows the proposed action and asks for confirmation.
Screenchart performs the actual calculations.

### 6. Screen Capture

The existing capability becomes a data-source feature:

- Capture a table, chart, dashboard, PDF, or application.
- Extract it into an editable dataset.
- Review extracted values before using them.
- Add captured data to an existing project.
- Replace or append data with another capture.
- Move directly from capture to visualization or dashboard.
- Preserve the original screenshot for verification.

### 7. Sharing & Collaboration

Everything stays local-first: no hosted service, no accounts, no data broker. Sharing produces a
file or a repo the user owns, and data never leaves a machine unless the user chooses. Three
serverless tiers, each for a different recipient:

**Tier 1 — Static export (for anyone, no app needed).**

- Export a dashboard or visual to a self-contained HTML file (data + charts/maps inlined, no
  server, opens by double-click and stays interactive: filters, tooltips, hover).
- Export to PDF and PNG for a frozen snapshot.
- Use for sending a finished view to an exec or an external person who will not install the app.

**Tier 2 — Dashboards as code, shared via git (for teams, the headline).**

- A project (source config, dataset steps, visuals, dashboard layout) saves as human-readable
  text (JSON/YAML), so it is diffable and reviewable.
- A user puts the project in a git repo; a teammate clones it, opens it in their own Screenchart,
  points it at the data source, and refreshes — queries run live against *their* data access, not
  a frozen snapshot.
- Collaboration comes free from GitHub/GitLab: versioning, pull requests, comments, and who-can-
  see-it (private repos). Screenchart builds none of that.
- **Secrets never enter the repo.** The project stores connection *config* (host, database, the
  query) but never the password or API key; those stay local and gitignored, exactly like today's
  BYOK keys. Each teammate supplies their own credential once. An optional committed cache lets a
  cloner without data access still see the last-saved numbers.

**Tier 3 — Hosted, account-based live sharing (explicitly deferred).**

- A Power BI-style shared link where a viewer with an account filters and the query hits the
  database requires an always-on server between the viewer and the data. That is a separate
  hosted or self-hosted product (the Metabase/Superset model), out of scope for the desktop v1.
  Kept in the deferred list; the git model above covers live team sharing without a server.

## Month 1: Product Foundation and Data Sources

### Week 1 — Define the complete product

Goals:

- Finalize the primary user: individual analysts, developers, researchers, and privacy-conscious
  professionals.
- Write the single end-to-end product journey.
- Define what every main screen must accomplish.
- Decide the project terminology: Source, Dataset, Visual, Dashboard, and Project.
- Audit the existing app and classify features as reusable, improvable, or replaceable.
- Establish the four-month feature boundary.
- Create sample datasets representing sales, finance, marketing, geographic, and operational data.
- Establish measurable release criteria.

Brand work:

- Decide whether Screenchart remains the final name.
- Create a shortlist if rebranding.
- Check names, repositories, domains, and possible conflicts.
- Do not purchase a new domain until a final choice is validated.
- Complete any rebrand by the end of Month 1.

Deliverable: approved v1 product definition and complete user journey.

### Week 2 — Create the workspace experience

Goals:

- Establish a clear home screen.
- Let users create, open, rename, and delete projects.
- Design navigation between Sources, Datasets, Visuals, Dashboards, and AI.
- Make Screen Capture available as one source option.
- Create helpful empty states for first-time users.
- Preserve the current quick-capture experience.
- Ensure users understand that AI is optional.

Deliverable: users can create a project and understand the entire workflow.

### Week 3 — File-based data sources

Goals:

- Add CSV, Excel, JSON, pasted data, and screenshot imports.
- Show an import preview.
- Let users select sheets where relevant.
- Detect column names and likely data types.
- Explain invalid or unsupported data clearly.
- Save imported datasets inside a project.
- Test small, large, clean, and messy files.

Deliverable: a user can import common files and receive a usable dataset.

### Week 4 — Connected data sources

Goals:

- Add the first database connections.
- Add a simple API/web-data connection.
- Save connection details safely.
- Let users select the data they want.
- Provide manual refresh.
- Show connection status and last refresh time.
- Handle unavailable or changed sources gracefully.

Month 1 milestone:

> Users can create a project and bring data into it from files, screenshots, databases, or APIs.

## Month 2: Dataset Studio and Visual Builder

### Week 5 — Dataset exploration

Goals:

- Build a clear table preview.
- Display column names, types, and basic summaries.
- Add sorting, filtering, search, and column selection.
- Let users rename columns and correct types.
- Surface empty values, duplicates, and obvious quality problems.
- Add AI explanations for unfamiliar datasets.

Deliverable: users can inspect and understand imported data.

### Week 6 — Data preparation

Goals:

- Add calculated fields.
- Add grouping and aggregation.
- Add common cleanup operations.
- Allow datasets to be combined.
- Record every transformation as an editable step.
- Make transformations reversible.
- Allow AI to propose transformations.
- Require confirmation before AI modifies a dataset.

Deliverable: users can turn raw data into an analysis-ready dataset.

### Week 7 — Manual visualization

Goals:

- Create visuals without AI.
- Let users select dimensions and measures.
- Recommend compatible chart types.
- Support filtering and aggregation.
- Reuse Screenchart's existing chart and map library.
- Prevent unsuitable chart choices or explain why they may be misleading.
- Make creating the first visualization fast and understandable.

Deliverable: users can build useful charts manually from their datasets.

### Week 8 — Visual customization and saving

Goals:

- Add titles, labels, legends, axes, colors, and number formatting.
- Add visual-level filters.
- Allow switching chart types without losing work.
- Save, rename, duplicate, and delete visuals.
- Add AI chart creation and recommendations.
- Let users edit everything AI creates.
- Test every supported chart with representative datasets.

Month 2 milestone:

> Users can import data, prepare it, and build polished visualizations with or without AI.

## Month 3: Dashboards and AI Copilot

### Week 9 — Dashboard creation

Goals:

- Create dashboards from saved visuals.
- Add, remove, resize, and rearrange visual cards.
- Add headings, explanatory text, and metric cards.
- Save dashboard layouts.
- Add multiple dashboard pages.
- Provide useful starter layouts without forcing templates.

Deliverable: users can turn individual visuals into a coherent dashboard.

### Week 10 — Dashboard interactions and sharing

Goals:

- Add dashboard-wide filters.
- Connect filters to multiple visuals.
- Support time-period and category controls.
- Add presentation mode.
- Add dashboard export: self-contained interactive HTML, plus PDF and PNG (Tier 1 sharing).
- Save projects as human-readable text and keep secrets out of that file, so a project folder can
  be committed to a git repo and cloned by a teammate (Tier 2, dashboards as code).
- On clone-and-open, re-run against the teammate's own data source and refresh live; fall back to
  an optional committed cache when they lack access.
- Preserve readable layouts at different window sizes.
- Make broken or outdated dataset links visible.

Deliverable: dashboards are interactive, presentation-ready, and shareable as a static file or a
git-tracked project.

### Week 11 — Persistent AI Copilot

Goals:

- Add the AI panel across the workspace.
- Make AI aware of the currently selected source, dataset, visual, or dashboard.
- Let users ask questions in plain language.
- Show which data supports an answer.
- Separate computed facts from AI interpretation.
- Preserve conversation history within a project.
- Allow users to disable AI completely.

Deliverable: AI can assist throughout the product without becoming mandatory.

### Week 12 — Embedded AI actions

Goals:

- Add contextual AI actions to each product area.
- Generate proposed cleaning steps.
- Generate calculated-field suggestions.
- Recommend and create visualizations.
- Draft dashboards from selected datasets.
- Generate dashboard summaries.
- Explain unusual changes and possible causes.
- Make every AI-created artifact editable.
- Clearly show when AI is making an interpretation rather than reporting a computed fact.

Month 3 milestone:

> The complete workflow works: source → dataset → visual → dashboard → AI analysis → export/share.

## Month 4: Completion, Quality, Beta, and Launch

### Week 13 — Complete screen capture integration

Goals:

- Integrate the original Screenchart workflow into projects.
- Improve extraction review and correction.
- Let captured data become a reusable dataset.
- Preserve links between screenshots and extracted values.
- Support recapturing, replacing, and appending data.
- Test screenshots from spreadsheets, PDFs, dashboards, charts, and tables.

Deliverable: screen capture feels like a flagship data source rather than a separate utility.

### Week 14 — Product-wide quality pass

Goals:

- Test every complete user journey.
- Test with and without AI.
- Test local and cloud AI configurations.
- Test macOS and Windows.
- Improve performance with larger datasets and dashboards.
- Fix confusing navigation and wording.
- Improve accessibility and keyboard navigation.
- Ensure failed imports, connections, and AI requests never destroy user work.
- Confirm projects reopen correctly.
- Complete privacy and security review.

Deliverable: release candidate suitable for external testing.

### Week 15 — Private beta

Recruit approximately 15–25 testers from the intended audience.

Ask each tester to complete:

1. Import a real dataset.
2. Prepare or clean it.
3. Create at least two visuals.
4. Build a dashboard.
5. Use the AI Copilot.
6. Export or present the result.

Track:

- Where users become confused.
- Time to first visualization.
- Time to first dashboard.
- Failed imports or connections.
- Incorrect AI suggestions.
- Missing manual controls.
- Crashes and lost work.
- Features users expected but could not find.

Fix release-blocking and high-impact issues. Avoid adding large new features.

Deliverable: validated release candidate.

### Week 16 — Public launch

Product work:

- Resolve remaining launch blockers.
- Finalize onboarding.
- Create starter projects and example datasets.
- Complete help documentation.
- Publish a clear privacy explanation.
- Publish the supported-source and visualization lists.

GitHub work:

- Rewrite the repository description around the expanded product.
- Create a strong visual README.
- Add a short demonstration video.
- Add screenshots of sources, datasets, visuals, dashboards, and AI.
- Publish a public roadmap.
- Improve contribution instructions.
- Add issue templates and feature-request discussions.
- Tag and publish the new release.

Launch messaging:

> An open-source, local-first data visualization workspace. Connect data, prepare datasets, build
> dashboards, and analyze everything with optional AI.

Month 4 milestone:

> A complete public v1 that real users can install and use from data import through dashboard
> export.

## Weekly Working Rhythm

As the founder, divide your time approximately as follows:

- 60% product creation.
- 15% testing and reviewing agent work.
- 10% user feedback.
- 10% documentation and demonstrations.
- 5% community and launch preparation.

Suggested weekly rhythm:

- Monday: select the week's outcomes and assign agent tasks.
- Tuesday–Wednesday: primary product work.
- Thursday: connect and review completed work.
- Friday: end-to-end testing and fixes.
- Saturday: documentation, demonstrations, and user feedback.
- End of week: do not proceed until the week's main user journey works.

AI agents can assist with separate implementation, testing, documentation, research, and review
tasks. You remain responsible for product decisions and final acceptance.

## Features Explicitly Deferred Beyond v1

These should not enter the four-month plan:

- Enterprise accounts and organizations.
- Complex permissions and governance.
- Real-time collaboration (live multi-cursor editing).
- Cloud-hosted or self-hosted dashboard server with accounts and live shared links (Tier 3
  sharing). The git model (Tier 2) covers live team sharing without a server in v1.
- Hundreds of data connectors.
- Mobile applications.
- Enterprise SSO.
- Row-level security.
- Real-time streaming analytics.
- Plugin marketplace.
- Public dashboard hosting.
- Full Power BI or Tableau feature parity.

Adding these would prevent the core product from reaching a reliable release.

## Release Success Criteria

The product is ready when a new user can:

- Install and begin without assistance.
- Import or connect real data.
- Prepare that data without leaving Screenchart.
- Create a visualization manually.
- Create another visualization using AI.
- Build an interactive dashboard.
- Ask questions about that dashboard.
- Verify where computed figures came from.
- Save, reopen, and refresh the project.
- Export or present the result.
- Share it: a static file for anyone, or a git-tracked project a teammate clones and refreshes
  against their own data.
- Complete the full workflow without enabling AI.

The most important measure is not the number of features. It is whether users can complete the
full journey reliably and want to use Screenchart for their next dataset.
