# Version diff — see what changed before you restore

## What you will see when this is done

Open a dashboard's **History** (`/versions/<project>/dashboard/<id>`) and pick an
older save: its preview banner now has **Compare with current** beside Restore. It
opens the compare view in the right-hand pane; while it is open, picking a save in
the list makes it the “from” side, and the two pickers choose any pair:

- A header of two version pickers, **“v3 · Oct 2, 2026, 2:05 PM” → “Current · …”**,
  each with “by priya@acme.com” under it, so any two saves can be compared, plus
  Swap and Close. The compare lives in the address (`?compare=<key>&to=<key>`).
- A summary line written by the server: **“3 cards changed, 1 card added, 1 card
  removed, a filter changed”**, with coloured count chips under it.
- For a dashboard, a **side-by-side pair of layout thumbnails** per sheet that
  changed — the same `LayoutThumb` the history list draws — with added tiles green,
  removed red, changed amber and moved/resized blue, and a small legend.
- **Changes**, as sentences, grouped (Dashboard · Filters · Cards):
  “Revenue by region now shows Sales by month”, “Filter Region = East was
  removed”, “‘Churn’ moved from row 3 to row 1”, “Title changed from ‘Q3’ to ‘Q4’”,
  “‘Notes’: text edited” with an **inline word diff** (struck-through red / green).
- **Figures that moved**: for every KPI card whose spec or scope changed, the figure
  under EACH version's spec, **computed now on current data** through the existing
  door (`computeCardMetric`, or `resolveMetric` for a saved-metric card — which
  itself goes through `computeCardMetric`): “Total revenue 1.2M → 3.4M · filters
  changed”. A Live dataset is asked of its warehouse; a refusal shows the server's
  typed sentence through `<LiveRefusalLine>`, never a retry and never a stored figure.
- **Restore v3** (the existing `versions:restore`) behind a confirmation dialog that
  restates the summary (“Restoring v3 undoes: 3 cards changed, …. The current
  version stays in the history.”).
- Designed loading (skeleton), no-changes (“These two versions are the same”),
  error (retry) and many-changes states, in both themes.

The same view works for every record type that keeps a history — dashboards (the
`dashboard` version type IS the analysis: published dashboards are snapshots and
keep no history), visuals, metrics, reports and dataset pipelines. Layout
thumbnails are dashboard-only; figures are dashboards' KPI cards and a metric's own
value.

## Decisions (made here, the user being away)

1. **Two channels, not one.** `versions:diff` is pure structure (fast, file reads
   only); `versions:figures` computes. The view paints the diff at once and the
   figures arrive beside it with their own skeleton; a slow warehouse never holds
   up the sentence list. Both are `read`, project-scoped, strict zod input
   `{projectId, type, id, from, to}` (`from`/`to` are version keys).
2. **“Current” is the newest version.** Every store write records a version
   (`versions.record` after each update), and the history page already labels the
   newest save “Current”. Passing its key keeps one code path and lets any two
   versions be compared.
3. **Version numbers are positional**: `v1` is the oldest save kept; the newest is
   “Current”. With the 50-save cap the numbers shift when the oldest is pruned —
   honest about what is kept, documented in the UI tooltip.
4. **Author**: a version now records `by` (the signed-in user's email, from
   `ctx()`), additively — older versions have none and the header omits “by”.
   No migration: versions are files / `records` rows through `recordFs`.
5. **Matching cards**: by card `id` across all sheets (a card dragged to another
   sheet is a move). A card WITHOUT an id (an old or hand-made snapshot) falls back
   to `type + title` (+ occurrence index for duplicates) — sanitized records always
   carry ids, so the fallback is rare, and it can only mis-pair two cards sharing a
   type and a title.
6. **Classification**, per matched card: `added` / `removed`; `changed` when any
   field other than layout/placement differs; else `moved` when its sheet, row or
   column changed, or it was resized. The tile colour takes the strongest status.
   **Rows** are the card's rank among the distinct `y` values of its sheet, so
   “row 2” is what a reader counts, not a grid unit.
7. **Field changes in a fixed order** per card type (visual: source visual,
   snapshot chart/encoding, actions; KPI: label, measure, saved metric, format,
   comparison, calculation, scenario, dataset; text: heading, body; control:
   label, column, kind, default; anything else: “settings changed”).
8. **Filters** are matched by column: same column on both sides with a different
   step = “changed”, else added/removed. Sentences reuse `describeFilter`
   (`metricFormat.ts`, now exported) so a filter reads the same as on a metric.
9. **Word diff**: LCS over whitespace-separated tokens, capped at 400 tokens a side
   (past that: one removed run and one added run). Server-side, pure.
10. **Sentences go through the catalog**: `src/analysis/versionDiffMessages.ts` is
    in `MAIN_FILES`; the pure diff returns structured changes, the messages file
    words them. Figures are formatted (`formatValue` with the card's format,
    `resolveMetric`'s own `display`) before they reach `t()` — they never do: the
    figure row is structured `{title, before, after, reason}`.
11. **What a figure means**: the base figure of the card under that version's
    saved dashboard filters, with the dashboard's CURRENT parameter values
    (parameters are not part of a version). A control's default, a comparison
    period, a table calculation and a scenario are not applied — the row is about
    what the spec change did to the number. At most 12 figures per compare.
12. **Figures for other types**: a metric version computes its definition + own
    filters through `previewDefinition` (the editor's preview door), using the
    metric's current dataset. Visuals, reports and pipelines have none.
13. **Restore** stays the existing `versions:restore` (`write`), now behind a
    confirmation that restates the summary.
14. **No thumbnails drawn anew**: `LayoutThumb` gains an optional per-tile
    `status` (a `data-status` attribute) and the compare view draws it larger.

## Files

| File | Job |
| --- | --- |
| `src/analysis/versionDiff.ts` | pure structural diff of a dashboard version pair |
| `src/analysis/versionDiffParts.ts` | pure diffs of the other four types, filters, word diff |
| `src/analysis/versionDiffMessages.ts` | the catalog sentences |
| `src/ipc/versionDiff.ts` | `versions:diff` / `versions:figures` handlers |
| `web/src/features/projects/VersionCompare.tsx` (+ `.module.css`) | the compare view |
| `scripts/test-versionDiff.ts` | server suite (fixtures + negative controls) |
| `web/e2e/versionDiff.e2e.ts`, `web/e2e/seed-versionDiff.ts` | edit → compare → restore |
| `web/src/features/projects/VersionFigures.tsx` | the “figures that moved” table |
| `web/src/features/projects/VersionCompare.test.tsx` | loading, same, error, many changes, opening from the history |

Screens (both themes): `web/e2e/__screens__/versions-compare-*.png`,
`versions-compare-changes-*.png`, `versions-compare-confirm-*.png`.

Shared files touched, additively: `src/api/versions.ts` (two contracts),
`scripts/i18n-extract.ts` (`MAIN_FILES` += one file), `src/i18n/en.json`
(regenerated by the extractor) and the es/de/fr/ja drafts (this feature's keys
translated, so each draft stays ≥ 90% as `test-i18n` requires), `src/app/versions.ts`
(`by`), `src/analysis/metricFormat.ts` (`describeFilter` exported),
`web/src/api/freshness.ts` (`versions:figures` follows a data refresh),
`VersionsPage.tsx` / `VersionPreview.tsx` / `Versions.module.css` (the entry point,
`LayoutThumb` statuses, the author on a row). No migration.

## Summary-line wording

The noun is said in every clause (“1 card added”, not “1 added”): the catalog's
extractor only takes a clause that reads as words, and a bare “{n} added” would
have to be spelled by hand — so each clause is its own whole phrase, which also
reads better translated.
