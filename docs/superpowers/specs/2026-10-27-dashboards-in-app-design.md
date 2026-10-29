# Dashboards inside the app

Status: design, approved approach (2026-10-27). Builds on develop after the revert of "Dashboard
shapes" (#331, reverted in #333).

## Intent

Today the **Dashboards** page is a list of published links. Clicking one leaves the app for
`/p/<id>/`, which opens on a list page (the link can bundle several dashboards), and only a second
click shows the dashboard — in its own light/dark, which does not match the app. The dashboards a
person builds live under **Analyses**. The user found this confusing: "why not just put the
dashboard in /dashboards".

The fix flips it: **the Dashboards page shows dashboards, and a link is only a way to share one**
— the way Tableau, Power BI and QuickSight work. You open a dashboard in one click, inside the app,
with the sidebar, today's numbers and the app's own light/dark.

## What the user sees

1. **Dashboards page** (`/dashboards?project=<id>`), no tabs: every dashboard of the project marked
   **Ready**, as cards with a small preview, its name, sheet count and when it was last updated.
   Click a card to open it. Empty state when none are Ready: says what Ready means; editors get a
   way to Analyses and to Create dashboard. (Amended 2026-10-28: the **Shared links** tab is gone.
   The list of published `/p/` links keeps only its address, `&tab=links`, which nothing in the
   app links to; the ⋯ Publish… item on the editing screen is gone too.)
2. **A dashboard opened from that page** (`/dashboards/<projectId>/<dashboardId>`): the dashboard
   in view mode inside the app — the same canvas as the editing screen with every editing tool
   hidden. Its own header (`dashboards/ViewHead.tsx`, amended 2026-10-28): "Dashboards / <project>"
   back to the list, the name, how fresh the figures are (once — a card repeats it only when its own
   figure is stale), then Compare, Subscribe, **Expand** (the dashboard over the whole window, its
   header kept; Esc gives the window back) and ⋯ (**Copy link** for everyone — the live in-app
   address — Comments, Export HTML, Print); no Present. Underlined sheet tabs only when there is more
   than one sheet. The filters sit in one box, as on `/p/<id>/`: each label over its widget, then the
   saved views (picked and linked only; they are saved and edited in Analyses) and Reset. The "Click
   to filter" row is gone: a clickable chart says so in its tooltip. Card titles are small capitals
   with no rule under them, on one background with the header. It reads like `/p/<id>/`: no Edit,
   no layout size switch, no History or Lineage — authoring stays in Analyses.
   No "View only" badge on this page — viewing is the point of it.
3. **Ready switch** on the editing screen's header (editors and admins only): on means the
   dashboard is on the Dashboards page; off takes it off. Nothing else changes; nothing is deleted.
   The Analyses list shows a small "Ready" mark on dashboards that are Ready.
4. **Copy link** copies `/dashboards/<p>/<id>`, the live page, for editors and viewers alike.
   (Amended 2026-10-28: it used to be Share link, which opened the Publish dialog for editors.)
5. **A published link that holds one page opens straight on it** — no list page — including
   links already shared. A link holding several keeps its list page.

## Decisions

The user's:
- The Dashboards page shows **only dashboards marked Ready**.
- In the app, a dashboard **follows the app's light/dark switch** (picked over "always dark").
- **Reuse the editing screen in a view-only mode** (picked over showing the published copy inside
  the app in a frame).

Claude's calls (check these):
- Ready is stored on the dashboard record as `ready?: true`; absent means not Ready, so every
  existing dashboard starts not Ready and no migration is needed (records are JSON / `records`
  rows). Toggling Ready must not count as an edit that conflicts with someone editing the sheets,
  and should not bump `updatedAt` (it is not a content change).
- Only `write` access can change Ready; everyone who can read the project sees the Dashboards tab.
- Existing dashboards are not auto-marked Ready. After this ships the Dashboards tab is empty until
  an editor marks one — the empty state must explain that plainly and point editors to Analyses.
  (Checked with the user 2026-10-28: start empty.)
- The card preview reuses the Analyses page's own card preview (the first sheet's first two
  visuals, already on the `analysis:gallery` reply, figures batched through `analysis:tiles`), not
  a new screenshot pipeline. (Checked with the user 2026-10-28: picked over Home's silhouettes.)
- The one-page redirect is done by the server for `/p/<id>/` (so old links benefit), not only
  by changing the link the app shows. (Checked with the user 2026-10-28: ANY link holding exactly
  one page — a dashboard, a story or a scorecard — opens straight on it.)
- **Links stay in view mode inside the view page.** Navigation cards, the navigate action and the
  back crumb (`KindCards.tsx`, `tileActions.tsx`) go to `/dashboards/<p>/<id>` when the dashboard
  is open in view mode, and to `/analyses/<p>/<id>` when it is open for editing. Every other entry
  point is unchanged: Home, ⌘K, Versions, subscriptions, the alerts bell, saved views' "Copy link",
  and server-built links in emails, alert posts and mentions (`publicUrl.ts`, `threadPath.ts`) all
  keep pointing at `/analyses/…` — emailed links are permanent, and the editing screen still opens
  read-only for viewers as today.
- `/dashboards/<p>/<id>` opens **any** dashboard the person can read, Ready or not — a navigation
  target may not be Ready. Ready decides only what the Dashboards tab lists.
- **Copy link for everyone.** It copies the in-app address `/dashboards/<p>/<id>`, which anyone in
  the project can open, and always shows the dashboard as it is now — never a snapshot.
- **A dashboard's own Style still applies.** The view page renders exactly as the editor does. A
  dashboard whose Style theme is Auto (the default) follows the app's light/dark switch; one an
  editor set to Light, Dark or Executive keeps that look on both pages. No view-only CSS.

## Goals

- One click from the Dashboards page to a dashboard, inside the app.
- The dashboard matches the app's theme in light and dark.
- Editors decide what appears on the Dashboards page.
- Shared links keep working exactly as before; only where they are listed changes.

## Non-goals

- Changing how dashboards look (cards, charts, KPI tiles) — that is the NEXT project.
- Hiding non-Ready dashboards from viewers elsewhere (Analyses, Home, search). Ready only decides
  the Dashboards page.
- Changing what a published page looks like, or its theme.
- The AI draft making narrow dashboards (parked by the user).
- Renaming "Analyses" or reordering the sidebar.

## Anti-goals (a failure even if it works)

- Opening a dashboard from the Dashboards page leaves the app or takes two clicks.
- The view page shows any editing tool (add, rename, drag, resize, undo, card properties).
- The view page computes a figure the edit page does not (same doors, same numbers).
- A second copy of the canvas or chart code for the view page.

## Approaches considered

1. **Chosen — view mode of the existing editor.** A new route renders the same `Editor` the
   editing screen uses, read-only, with a header made for reading. Live data, the app's theme,
   every reader tool that exists already (filters, views, comments, Present, export). Design work
   in the next project improves edit and view at once. Cost: the header needs a viewing variant,
   and the editor's `readOnly` path must hold for editors too, not only for viewers.
2. Rejected — the published copy in a frame inside the app. Frozen numbers, its own theme (against
   the user's pick), two clicks for multi-dashboard links, and it needs `frame-ancestors 'none'`
   loosened on `/p/`, a clickjacking control.
3. Rejected — a new read-only renderer for the view page. A third renderer next to the canvas and
   the published site; duplicate code that drifts.

## Constraints (house rules that apply)

- `web/src/app/routes.tsx`, `web/src/app/nav.ts`, `src/api/index.ts` are **append-only**.
- A new channel needs a contract in `src/api/` with a real zod input and the narrowest access
  (`write` for Ready, scoped by `project`); `scripts/check-contracts.js` must list 0 unresolved.
- Every list, panel and page has designed empty, loading and error states, in both themes.
- One Playwright e2e per screen (`web/e2e/`), RPC budget 25 per page load, light + dark
  screenshots; Vitest next to components.
- Files: 500 soft / 800 hard lines. `Editor.tsx` is 448 and `Head.tsx` 244 — a viewing header
  is its own small file rather than more branches in `Head.tsx` if that keeps both readable.
- No new runtime dependency. Server sentences through the `t()` catalog.

## Left to the builder

- Channel shape for Ready (its own `analysis:setReady`, or a field on an existing update channel)
  — as long as toggling it never trips the edit-conflict guard or bumps `updatedAt`.
- Which list channel carries `ready` (the summary the Analyses page and the new tab read).
- How the view route tells `Editor` it is viewing (a prop next to `readOnly`) and how the header
  variant is split.
- Where the Analyses list shows the Ready mark.

## Later

- The dashboard design work (next).
- The AI draft's narrow dashboards.
