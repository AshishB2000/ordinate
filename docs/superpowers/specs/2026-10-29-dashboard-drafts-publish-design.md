# Dashboards: drafts and publish (Analyses folds into Dashboards)

Status: design, approved by the user 2026-10-29 ("build it all"). Builds on develop at `ba8ab1b9`
(#345). Supersedes the Ready switch of `2026-10-27-dashboards-in-app-design.md`.

Clickable prototype the user reviewed and commented on (local copies, readable on this machine):
`/private/tmp/claude-501/-Users-ashishb-Projects-ordinate/f134e052-8c22-437b-9fc4-a432dbe6c4a3/scratchpad/dash-proto/dashboards-prototype.html`
(all nine screens on one page) and the per-screen sources in `.../scratchpad/dash-mockup/project/*.dc.html`.
The prototype's look is a sketch in the app's tokens; match the app's real components, not its pixels.

## Intent

Today there are two places: **Analyses** (every dashboard, where you edit) and **Dashboards** (only the
ones an editor switched to Ready). Ready is a flag: an edit to a Ready dashboard shows to viewers at once,
half-finished. The user wants one place, **Dashboards**, where every dashboard — made by a person or by
the AI — starts as a **draft** only editors and admins see, can be **previewed** exactly as viewers will
see it, and is **published** when ready. After that, viewers keep seeing the **last published version**
until someone publishes again (the user's words: "keep last published version until publish again").

## What people see

**Roles.** Project roles are `viewer`, `editor`, `admin` (`src/server/authz`). Editors and admins see
drafts and published dashboards. **Viewers see published dashboards only** — never a draft, never a
draft's name, never draft history — everywhere in the app, not only on the Dashboards page.

1. **Sidebar:** the Analyses item is gone. Dashboards is the one place.
2. **Dashboards page** (`/dashboards?project=<id>`):
   - Editor/admin: header buttons **Draft with AI** and **Create dashboard** (a split button; its arrow
     opens a small menu: **Blank dashboard**, **Rebuild from a screenshot**). No separate Rebuild button
     in the header (user comment: rarely used, does not belong on top). Two tabs, **Published**
     (default) and **Drafts**, with counts — **no "All" tab** (user comment). Published holds every
     published dashboard; one with unpublished edits stays there with an **"Edits not live"** badge.
     Drafts holds the never-published ones.
   - Each card: preview, name, a status badge where it adds information (Published / Edits not live /
     Draft), and plain meta: `by <name> · <when>` or sheet count and date. **No "Made by AI" or "From a
     screenshot" badge** (user comment: how a draft was started does not matter).
   - Card ⋯ menu (editor/admin): Open published, Edit, Preview, Duplicate, Rename, History, Unpublish
     (published only), Delete. Viewer: no ⋯ menu beyond **Copy link**.
   - Viewer: published dashboards only; no tabs, no create buttons.
   - Empty states, both themes: editor ("Start your first dashboard": Create dashboard, Draft with AI,
     a quiet link "Have a screenshot of a dashboard from another tool? Rebuild it here", the existing
     start-from-a-dataset chips); viewer ("Nothing published yet"); an empty Drafts tab.
3. **Editing a draft** (the existing editor): back link goes to Dashboards. Status shows **Draft**.
   Header actions: **Preview** and **Publish** (primary). The Ready switch is gone.
4. **Preview:** the view page rendering the **draft**, with a strip on top: "Preview. This is how viewers
   will see this dashboard once you publish it." — **Back to editing**, **Publish**.
5. **Publish dialog:** "Publish “<name>”?" — everyone in the project can see it; viewers see this
   version (layout, filters and charts freeze; later edits stay in the draft until you publish again);
   figures stay live; a summary (sheets, charts, KPIs, filters). Cancel / Publish.
6. **Published dashboard** (`/dashboards/<p>/<id>`): renders the **published copy** for everyone. Editors
   also get an **Edit** button and, when the draft differs, a line "You have edits that aren't live yet ·
   Open the draft".
7. **Editing a published dashboard:** status "**Edits not live · published <date>**"; actions **Discard
   edits** (confirmed), **Preview**, **Publish changes**; ⋯ adds **View published version** and
   **Unpublish** (takes it off the Dashboards page; the draft stays). When the draft differs, a strip:
   "Not live yet: 1 card added, 1 card changed since you published on <date>. See changes" (the
   existing version-diff summary and compare view).
8. **Draft with AI:** the review step's button reads **Create draft**, with a note that it stays a draft
   only editors and admins see until published.

## Decisions

The user's:
- One place, Dashboards; Analyses leaves the sidebar.
- Drafts are editors'/admins' only; viewers see only published dashboards.
- Viewers keep the last published version until the next Publish.
- Approach 1 of three: **a published copy kept inside the dashboard record** (rejected: pointing at a
  History version — History keeps only 50 saves and charts would still be shared; and a separate
  published-dashboard record — the old two-artifact model removed in phase 6).
- Published / Drafts tabs, no All; Rebuild from screenshot moves off the header; no made-by badges.

Claude's calls (check these):
- **Charts freeze too.** A card points at a chart in the Visuals store (`visualId`), so editing that
  chart would change a published dashboard. Publish copies each visual card's definition into the copy
  as the existing inline `card.visual` (`CardVisual`, `src/analysis/dashboards.ts`), keeping
  `visualId`. Renderers already prefer a frozen `card.visual` (see `src/ipc/visuals.ts` `visual:rows`
  comment); make sure the canvas, `analysis:tiles`, exports, subscriptions and `/p/` honour it too.
  **Figures stay live** — nothing stores a number (house rule).
- The record gains an additive optional field, e.g. `published?: { name, sheets, filters, …whatever the
  view renders (style, parameter definitions, saved views), publishedAt, publishedBy, versionKey?,
  contentHash }`. Absent = never published. No SQL migration (records are JSON / `records` rows).
- **Existing `ready: true` dashboards become published** with their current content, so nothing that
  viewers see today disappears. Never-Ready dashboards become drafts. Lazy or one-time is the builder's
  call; it must be idempotent and never fatal.
- "Edits not live" = the draft's content differs from the copy's (compare a content hash of what the
  copy holds, not `updatedAt`, so undoing back to the published state reads as in sync).
- Discard edits restores layout, filters, text and KPI cards from the copy; visual cards keep their
  `visualId` and point at the chart's current definition (the Visuals store is shared, so discard never
  writes to it). Say so in the confirmation.
- Publish, Unpublish and Discard each record a version. Publish stores the version key it recorded, so
  the strip can diff "published → now"; if that version was pruned, the strip says "Edits not live"
  without counts.
- Never-published dashboard: viewers get not-found everywhere (same reply as a missing id). Editors
  opening `/dashboards/<p>/<id>` on a draft see the draft as a Preview.
- Subscriptions, alerts, `/p/` publishes, embeds and emails go to viewers, so they render the
  **published copy**; for a never-published dashboard only an editor can reach them, and they use the
  draft. The builder confirms each and lists them in the PR.
- The editor keeps its URL `/analyses/<p>/<id>` for now (emailed links, mentions and Versions point
  there). Only the list `/analyses` redirects to `/dashboards`. Renaming the editor URL is a later PR.
- `analysis:setReady` and the Ready switch are replaced by publish/unpublish; keep nothing that writes
  `ready` after the migration.
- The MCP surface (`src/automation/`, `plugins/ordinate/skills/build-dashboard`) creates drafts; a
  viewer's token sees only published dashboards. Update the plugin skill text; a publish tool for MCP
  is optional (say in the PR whether it was added).
- `nav.ts` is append-only by house rule; removing the Analyses line is the user's explicit request.

## Goals

- One place for dashboards; drafts hidden from viewers on every surface.
- What viewers see changes only when someone presses Publish.
- Preview before publishing, in the real view page.

## Non-goals

- Changing how dashboards look (cards, charts, KPI tiles).
- Renaming internal names (`analysis` record, `analysis:*` channels) or the editor URL.
- Approval workflows, scheduled publishing, per-person drafts.

## Anti-goals (a failure even if it works)

- A viewer can read a draft, a draft's name, or its history through any channel.
- An edit (to the dashboard or to a chart in Visuals) changes what viewers see without a Publish.
- A stored figure anywhere; a figure on the published page computed differently from the editor.
- A second canvas or chart renderer for the published copy.

## Constraints (house rules)

- `src/api/index.ts`, `web/src/app/routes.tsx`, `web/src/app/nav.ts` append-only (nav: the one line
  removal above). Every new channel: a contract with a real zod input, the narrowest access (`write`
  for publish/unpublish/discard), project-scoped; `node scripts/check-contracts.js` → 0 unresolved.
- Self-check suites in `scripts/test-*.ts`, differential where two paths exist (`Object.is`), every guard
  with a negative control. One Playwright e2e per screen (RPC budget 25, light + dark screenshots, fails
  on console errors / CSP). Vitest next to components.
- Files 500 soft / 800 hard. No new runtime dependency. Server sentences through `t()`.
- Every list, panel and page has designed empty, loading and error states in both themes.

## Work split

1. **Server and data** (one PR, first): the record field, migration from `ready`, publish / unpublish /
   discard channels and contracts, status on the gallery list, frozen charts honoured by every renderer,
   viewer filtering on every reader, web API hooks for the new channels, MCP + plugin skill, docs.
2. **Dashboards page and navigation** (after 1): the merged list page, tabs, card menus, create menu,
   empty states, sidebar, `/analyses` redirect, in-app links to the list.
3. **Editor, preview, publish and view page** (after 1, beside 2): header states, Publish dialog,
   Preview, Discard, Unpublish, the changes strip, the view page on the published copy, the AI draft
   wording.

Parts 2 and 3 touch disjoint files; each builder lists the files it owns in its PR.

## As built — part 1, server and data

What the builder decided where the design left it open (the user's decisions above are unchanged):

- **Record.** `Analysis.published?: PublishedCopy` = `{ name, sheets, filters, style, parameters,
  publishedAt, publishedBy?, versionKey?, contentHash }` (`src/analysis/publishedCopy.ts`) — the keys an
  editor's save writes, with each visual card's chart frozen as `card.visual` (overlays now included
  in `CardVisual`). Saved views are **not** frozen: they are reader state outside the content, so the
  copy's readers get the record's views checked against the copy's sheets. Sanitized on every load;
  an unusable copy is no copy.
- **Status** = `draft | published | edited`, from `contentTag('dashboard', draft) === contentHash`. A
  chart edited in Visuals does not flip it (Discard could not undo it; versions:diff would not show it).
- **Viewers, centrally.** `getAnalysis` / `listAnalyses` are caller-aware (`readsPublishedOnly`: the
  same project-role rule as row access, `authz/caller`): a viewer gets the copy or `null`. Readers
  that bypass the store guard themselves (history, Trash, catalog notes, comment threads, Home's recent
  comments, mention notices, a report's discussion page). `scripts/test-dashboardDraftsViewer.ts` walks
  every read contract a projectId satisfies, plus the by-id ones, as a viewer.
- **Audience paths** (`getAudienceAnalysis`): subscriptions, reports, `/p/` pages and embeds, the HTML
  export and the subscription preview render the published copy, or the draft of a dashboard never
  published. An HTML export from the editor of a dashboard with edits not live is therefore the
  published version.
- **Versions** gain `event: 'published' | 'unpublished' | 'discarded'`, written even when the content
  did not move. Publish stores that version's key.
- **Migration** from `ready: true` is lazy, on first read, under the record's lock, charts frozen,
  every other key byte for byte; idempotent; a failed write still reads as published.
- **Publish takes `base`** (the editor's tag): a draft that moved since is refused 409 — what goes
  live is what the editor saw.
- **No MCP publish tool.** `create_dashboard` makes a draft and says so; `list_dashboards` carries
  `status`; a viewer's token lists published ones only.
- **Ready switch.** Kept as a stopgap that publishes / unpublishes, so the app and its e2e keep
  working until part 3 replaces it with Preview / Publish.
- **Not done here:** a viewer's mention rows written before this release still show their snippet;
  waterfall totals for a row-restricted viewer are filled from the chart as stored now (rowDoors
  `storedFigureAsk`), not the frozen one.
