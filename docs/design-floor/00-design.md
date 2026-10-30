# The design floor: AA contrast, one page header, and the missing doors

Batch 3, item 5 (`feat/design-floor`). Four things, one floor under every screen:

1. **Text that reads.** `--text`, `--muted` and `--text-dim` reach WCAG AA (4.5:1) on every surface
   in both themes, every Badge tone and grid type chip reaches 4.5:1 on its own fill, and one Vitest
   (`web/src/theme.contrast.test.ts`) fails the day one stops.
2. **Settled screenshots.** Every e2e page runs with `prefers-reduced-motion: reduce`, so a
   screenshot shows the final frame of a chart, never the middle of its animation.
3. **One page header.** `Page` (`web/src/app/blocks.tsx`) gains a back crumb, a status chip, actions
   and a node title. Every detail page uses it; a guard fails on a back link built anywhere else.
4. **The doors where people look.** Databases, warehouses, apps and URLs from Data → Import and the
   Data header; Home → New → Dashboard opens the wizard; the Dashboards page can create one. The
   rail groups its sections into View and Build.

Out (the user's call or another item): renaming Analyses / Dashboards, a shared Section primitive,
a chart-palette review.

## 1. The contrast floor

### Why

The web port lost the desktop's AA pass (commit 4a79a25f) and its test. On develop @ 46bbfc3d,
light `--text-dim` #8a909c is 2.71–2.99:1 on every surface, `--text-faint` #aeb4bf 1.76–2.08:1, and
`--muted` drops to 4.39 on surface-2 and 4.09 on surface-3; dark dim is 2.71–3.80 and faint
1.69–2.38. They carry table headers, KPI names and deltas, timestamps, empty-state text and the
search and ask placeholders. The neutral Badge and the grid's type chip were dim at 11px (2.71:1),
and every tinted Badge tone missed: light ok 3.35, warn 2.89, error 4.09; dark accent 3.80.

### The rule

- `--text`, `--text-strong`, `--muted`, `--text-dim`: ≥ 4.5:1 on `--bg`, `--surface`, `--surface-2`,
  `--surface-3` and `--inset`.
- `--text-faint`: ≥ 3:1, and **only** for disabled controls, decorative icons and dividers. Words
  someone has to read (content, placeholders, counts) use `--text-dim` or stronger.
- A small word on a fill of its own (the five Badge tones, the grid's three type chips, the Data
  tab's type chip): its ink ≥ 4.5:1 on its fill, the fill **composited over each surface** first
  (a 10% tint over surface-3 is not the tint over white).

### The tokens

From the desktop's AA values (light muted #5f6672, dim #636a75, faint #6b7280; dark muted #a8aeb9,
dim #9ca3af, faint #8a919d), plus an ink per tone:

| token | light | dark | why this value |
|---|---|---|---|
| `--muted` | #5f6672 | #a8aeb9 | the desktop's |
| `--text-dim` | #636a75 | #9ca3af | the desktop's |
| `--text-faint` | #6b7280 | #8a919d | the desktop's |
| `--accent-text` | `var(--brand-accent-2, #1d4fd0)` | `var(--brand-dk-accent-fg, #7cb0ff)` | the desktop's, following a workspace accent |
| `--ok-text` | #065f46 | #34d399 | emerald-800 / the dark `--ok` |
| `--warn-text` | #92400e | #f5b53d | amber-800 / the dark `--warn` |
| `--error-text` | #be123c | #fca5a5 | rose-700 / red-300 |

The dashboard style presets (`Style.module.css`) redefine the same tokens, so each was raised the
same way: Light (`clean`) takes the light values; Executive takes the desktop's executive values
(muted #5d5852, dim #625d56, faint #6b665f, `--accent-text` #334155) with inks #0c6644 / #7f550b /
#b3123c; the dark sheet takes the dark values, except `--accent-text` **#8cbaff**: the desktop's
#7cb0ff reads 4.24:1 on the teal accent's 16% tint over the sheet's surface-3 (#313139), and
#8cbaff is the nearest step of the same blue that clears every accent axis (4.72 worst). The print
box (`Print.module.css .light`) and the five built-in themes a duplicate starts from
(`themeBuiltins.ts`) carry the same text values.

### The ratios

Computed by `theme.contrast.test.ts` (`PRINT_CONTRAST=1 npx vitest run src/theme.contrast.test.ts`
prints these tables), not by hand. Every colour is read from the stylesheets: theme.css, the preset
rules and the chip rules themselves.

**app light**

| | bg | surface | surface-2 | surface-3 | inset | floor |
|---|---:|---:|---:|---:|---:|---:|
| --text | 16.55 | 17.72 | 16.10 | 14.98 | 16.08 | 4.5 |
| --text-strong | 17.63 | 18.87 | 17.15 | 15.95 | 17.13 | 4.5 |
| --muted | 5.40 | 5.78 | 5.26 | 4.89 | 5.25 | 4.5 |
| --text-dim | 5.10 | 5.46 | 4.96 | 4.61 | 4.95 | 4.5 |
| --text-faint | 4.52 | 4.83 | 4.39 | 4.09 | 4.39 | 3 |
| Badge neutral | 4.89 | 4.89 | 4.89 | 4.89 | 4.89 | 4.5 |
| Badge accent | 5.71 | 6.13 | 5.56 | 5.20 | 5.55 | 4.5 |
| Badge ok | 6.38 | 6.84 | 6.24 | 5.81 | 6.24 | 4.5 |
| Badge warn | 5.85 | 6.22 | 5.73 | 5.36 | 5.72 | 4.5 |
| Badge error | 5.10 | 5.47 | 4.98 | 4.63 | 4.98 | 4.5 |
| Grid chip text | 4.89 | 4.89 | 4.89 | 4.89 | 4.89 | 4.5 |
| Grid chip number | 5.71 | 6.13 | 5.56 | 5.20 | 5.55 | 4.5 |
| Grid chip date | 7.69 | 8.20 | 7.48 | 7.00 | 7.48 | 4.5 |
| Data type chip | 5.26 | 5.26 | 5.26 | 5.26 | 5.26 | 4.5 |

**app dark**

| | bg | surface | surface-2 | surface-3 | inset | floor |
|---|---:|---:|---:|---:|---:|---:|
| --text | 15.58 | 14.40 | 12.75 | 11.09 | 15.00 | 4.5 |
| --text-strong | 18.39 | 16.99 | 15.04 | 13.08 | 17.70 | 4.5 |
| --muted | 8.25 | 7.62 | 6.75 | 5.87 | 7.94 | 4.5 |
| --text-dim | 7.24 | 6.69 | 5.93 | 5.15 | 6.97 | 4.5 |
| --text-faint | 5.79 | 5.35 | 4.74 | 4.12 | 5.58 | 3 |
| Badge neutral | 5.87 | 5.87 | 5.87 | 5.87 | 5.87 | 4.5 |
| Badge accent | 6.87 | 6.33 | 5.57 | 4.91 | 6.59 | 4.5 |
| Badge ok | 7.56 | 6.86 | 6.08 | 5.28 | 7.24 | 4.5 |
| Badge warn | 7.66 | 7.03 | 6.14 | 5.33 | 7.34 | 4.5 |
| Badge error | 8.10 | 7.38 | 6.51 | 5.74 | 7.72 | 4.5 |
| Grid chip text | 5.87 | 5.87 | 5.87 | 5.87 | 5.87 | 4.5 |
| Grid chip number | 6.87 | 6.33 | 5.57 | 4.91 | 6.59 | 4.5 |
| Grid chip date | 9.15 | 8.33 | 7.36 | 6.43 | 8.76 | 4.5 |
| Data type chip | 6.75 | 6.75 | 6.75 | 6.75 | 6.75 | 4.5 |

**The lowest of each over all 32 sheets** (both app themes; the Light, Executive and Dark presets and
`auto`, each under the blue, teal and slate accent axes in a light and a dark app; the print box;
the five built-in themes):

| | lowest | where | floor |
|---|---:|---|---:|
| --text | 10.93 | dark · blue (light app), surface-3 | 4.5 |
| --text-strong | 12.89 | dark · blue (light app), surface-3 | 4.5 |
| --muted | 4.89 | app light, surface-3 | 4.5 |
| --text-dim | 4.61 | app light, surface-3 | 4.5 |
| --text-faint | 4.06 | dark · blue (light app), surface-3 | 3 |
| Badge neutral | 4.89 | app light, bg | 4.5 |
| Badge accent | 4.72 | dark · teal (light app), surface-3 | 4.5 |
| Badge ok | 4.90 | executive · blue (light app), surface-3 | 4.5 |
| Badge warn | 4.59 | executive · blue (light app), surface-3 | 4.5 |
| Badge error | 4.63 | app light, surface-3 | 4.5 |
| Grid chip text | 4.89 | app light, bg | 4.5 |
| Grid chip number | 4.72 | dark · teal (light app), surface-3 | 4.5 |
| Grid chip date | 5.28 | auto · teal (dark app), surface-3 | 4.5 |
| Data type chip | 5.26 | app light, bg | 4.5 |

The lowest text figure is light `--text-dim` on surface-3 at 4.61, as the spec predicted.

### The chips

- The neutral Badge, the grid's `Abc` chip and the Data tab's type chip use `--muted` on their
  opaque fill.
- The accent Badge and the grid's `123` chip use `--accent-text` on `--accent-soft`; ok, warn and
  error use their `-text` ink on their `-soft` fill.
- The grid's `Date` chip keeps its 14% `--chart-4` tint and inks the word in `--chart-4` mixed
  halfway toward `--text-strong` (`color-mix`), so it keeps the palette's hue, follows a brand
  palette, and reads at 5.28 or more. (60% held on the app's own sheets but fell to 4.33 under the
  teal axis in a dark app, where the preset paints its light indigo on a dark surface.)

### Where faint was carrying words

Content and placeholders move from `--text-faint` to `--text-dim`: the Markdown tile's empty text
(`Dashboards.module.css .mdEmpty`), a gone lineage chip (`Data.module.css .lineGone`), the search,
ask, palette, SQL-editor and textarea placeholders (`Shell`, `Explore`, `Palette`, `Workbench`,
`Field`), the Select placeholder, the story block placeholder, Explore's group counts, Home's comment
count, Metrics' "unused", Pipelines' "no columns", Publish's empty line, a snapshot's `null` cell and
a revoked token's prefix. What stays faint is decorative: icons beside a label, separators, status
dots, meter fills, the sparkline's neutral stroke, a remove ×, a map glyph.

### `BRAND_DARK_SURFACES`

`web/src/charts/palette.ts` walks a workspace accent and its chart ramp to 3:1 (4:1 for the accent)
against the dark surfaces. It listed `#1c1c20` and `#232327`; a chart is also drawn on the floating
surface (dialogs, the dock, Explore's suggestion cards: `#26262c`) and the dark sheet's floating
surface (`#2a2a30`). The list becomes those four — every dark `--surface` and `--surface-float`, the
app's and the dark sheet's — and a test reads them out of theme.css and Style.module.css so the list
cannot drift from the CSS again.

The golden fixture (`__golden__/palette.json`) is the desktop's answers over the desktop's two
surfaces, and goldens are never re-recorded. So `brandTokens` and `valueRamp` take the surface list
as a parameter (defaulting to today's), and the golden test passes the recorded list: the desktop's
algorithm is still held to the desktop's answers with `Object.is`, and today's surfaces only change
the input.

The accent as **text** is a third input (review round). `--accent-text` reads `--brand-accent-2` in
light and `--brand-dk-accent-fg` in dark, and a Badge or number chip draws it on the accent's own
tint (8 % light, 16 % dark). The desktop walked the dark ink on three bare surfaces and never walked
the light one, so `#2563eb`'s dark ink read 4.00 on surface-2's tint. Both are now walked to 4.5:1 on
the tint composited over every surface of every sheet (`BRAND_INK_SURFACES`: bg, surface, surface-2/3,
inset, surface-float of the app's sheets and the dashboard presets', read out of the CSS by
`palette.test.ts`), starting from the desktop's answer. `null` for that parameter is the desktop's ink
rule, which is what the golden test passes. Seven brand seeds join the contrast gate.

## 2. Settled screenshots

`openSession()` (`web/e2e/fixtures.ts`) opens every context with `reducedMotion: 'reduce'`. The app
honours it (`web/src/charts/build.ts` turns Chart.js animation off; `base.css` zeroes the motion
tokens), so `screens()` shoots the final frame. The one-off `emulateMedia({ reducedMotion })` calls
in `charts`, `explore`, `figures`, `grids` and `data` go. The specs that open their own contexts for
another user (`auth`, `password`, `compose`, `row-access`, …) set it on those contexts where they
take screenshots.

## 3. One page header

### The contract

```tsx
<Page
  back={{ to: '/data/p1', label: 'Datasets' }}   // the parent crumb, ABOVE the title
  title={name}                                    // a string, or a node (an editable name)
  status={<Badge icon="eye">View only</Badge>}   // chips right after the title
  sub="One sentence"                              // a sentence (<p>) or a meta row (a node, <div>)
  actions={<>…<Button variant="primary">…</Button></>}  // right-aligned, at most one primary
>
  …the page…
</Page>
```

```
← Datasets                                          (13px, muted, arrow-left; a real <a>)
Orders  [CSV upload] [Live]                [Prepare] [View query] [New visual] [⋯]
5,000 rows · 9 columns · refreshed 2h ago
```

- `back` is `{ to, label }`, rendered by `BackLink` as a quiet crumb above the title: muted text, a
  16px arrow-left, `label` naming the parent page as its own heading names it — except where this
  page's title already is the parent's name (Prepare, an input table, a Live route over a dataset):
  there the crumb says what kind of page it goes to, "Dataset", rather than repeat the title.
- `title` is a string, or a node for an editable name (the analysis editor's rename button, a story
  or scorecard name input). It is always the page's one `<h1>`.
- `status` is one or more chips right after the title (View only, a save state, Live, a source).
- `sub` is a string sentence (`<p>`, ≤ 72ch, muted) or a node whose children stack (a sentence with
  a bold name, the dataset page's row of facts, its status and lineage lines), each laying out its
  own row.
- `actions` sit right, wrap below on a narrow window, and hold **at most one primary**. `PageHead`
  checks after render and logs `console.error` when it finds two, so the e2e harness (which fails
  on any console error) and the Vitest catch a second primary on any screen.
- A page with none of the new props renders exactly what it did: the title row and the sub keep
  their 4px gap and the 24px page gap is unchanged, so the 36 existing users do not move.

Two frames, one header. `Page` is the document frame (24/32px gutters). A workspace that fills the
window under a bar of its own (the analysis, story, scorecard, report, visual and connection
editors, the analytics workbenches) keeps its frame and renders `PageHead` itself, passing its bar's
padding and surface as `className`. The header inside is the same component, so the crumb, title,
status and actions sit in the same places on every page.

`useCameFrom(parent)` is the crumb for a page with more than one way in: an opener that is not the
parent passes `state: { back: { to, label } }` on its link, and the page shows that crumb, else its
parent. The analytics workbenches use it, which is how their "Close" becomes a back crumb to where
the user came from (the Analytics hub by default; the dataset from its "View query"; the dashboard
from a KPI's Why?; the analysis editor from a statistics card).

### The guard

`web/src/app/backLinks.test.ts` parses every `.ts` and `.tsx` under `web/src` (oxc, through Vite)
and counts every back icon it names — an `arrow-left` or `chevron-left` string in any position — and
every "← Word" it puts on screen, outside `blocks.tsx` and the icon set. How the element is wired
does not matter: a `<Link>`, a Button whose handler navigates under any name (`nav(`, a `goBack`
reference), a menu item in a `.ts` table. A file may hold back icons only if it is on `STEP_BACKS`,
with the exact count and the reason it is not a page's way back: a step back inside a flow (a
wizard's Back, "Change source", "Back to sources", the theme editor's "Themes"), a pager, the
dashboard viewer's drill-back, the canvas's "Narrower", an author's navigation card. One more use, or
an entry that outlived its use, fails. Negative control: planted files — a link, an aliased `nav(`, a
handler reference, a "← Data" glyph, a `.ts` menu item and an allowed file over its count — are all
caught, while a key hint ("←/→") and a mapping arrow ("{to} ←") are not.

### The detail pages (caller inventory)

| page | today | moves to |
|---|---|---|
| `data/DatasetPage.tsx` | crumb above (Header) | `Page` back "Datasets", status: source, Live, scoped, tags; sub: the meta row; actions |
| `reports/stories/StoryPage.tsx` | crumb left of the name in a bar | `PageHead` in its bar: back "Stories", name input title, save status |
| `reports/scorecards/ScorecardPage.tsx` | same | `PageHead`: back "Scorecards" |
| `reports/builder/ReportBuilder.tsx` | same | `PageHead`: back "Reports", status Unsaved |
| `analyses/editor/Head.tsx` | chevron crumb in the editor bar | `PageHead`: back "Analyses", the rename button as the title |
| `dashboards/phone/PhoneHead.tsx` | chevron-only tap target | `BackLink iconOnly` (same 44px target, same name) |
| `connections/WorkbenchPage.tsx` | bordered "← Connections" | `PageHead`: back "Connections" |
| `analytics/scenarios/ScenarioPage.tsx` | bordered "← Back" | `PageHead`: back "Scenarios" |
| `analytics/scenarios/ScenarioComparePage.tsx` | bordered "← Back" | `PageHead`: back "Scenarios" |
| `visuals/Editor.tsx` | "← Back" button | `PageHead`: back "Visuals" |
| `prepare/PreparePage.tsx` | crumbs under the title | `Page` back "Dataset"; Pipelines becomes an action |
| `import/CapturePage.tsx` | crumb bar under the title | `Page` back "Captures" |
| `analyses/metrics/tree/MetricTreePage.tsx` | crumb under the title | `Page` back "Metrics" |
| `live/LiveOff.tsx` (`LiveOffPage`) | "← Back to the dataset" under the title | `Page` back "Dataset" |
| `analyses/rebuild/RebuildPage.tsx`, `RebuildCheck.tsx` | crumb bar under the title | `Page` back "Analyses" |
| `analytics/Workbench.tsx` (stats, drivers, segments) | "× Close" on the right | `PageHead` + `useCameFrom`, default "Analytics" |
| `analytics/sql/QueryPage.tsx`, `events/EventsPage.tsx` | "× Analytics" on the right | same |
| `explore/Explorer.tsx` | its own `<h1>` block, no way back | `Page` (a top-level section: no back) |
| `data/DataSection.tsx` | its own header | `Page` with actions (and the new door) |

Untouched on purpose: Home (its greeting is the design), the sign-in and password pages (no shell),
the story presenter, the UI kit gallery. Kept as they are, because they are not back links: the
wizard and dialog step-backs (`NewWizard`, `AddKpi`, `NewVisualDialog`, `SubscribeDialog`), the
connection form's "Change source", the composer's "Back to sources", the theme editor's "Themes"
(closes an in-page editor), the audit log's and the scorecard's previous-page pagers, the
dashboard viewer's drill-back in its selection strip (`tileActions.tsx`: it restores the sheet and
the carried filters of the dashboard a navigate action came from, which is viewer state, not the
page's parent), the canvas "Narrower" menu item and a navigation card's authored arrow.

## 4. The doors

All four are an editor's: hidden, not disabled, for a viewer, and never seeded from `useCanEdit`
(false until the roles arrive).

- **Data → Import** (`ImportPage.tsx`) lists, after its five sources, "Database, warehouse or app"
  → `/connections/<project>` (the 40-source picker) and "From a URL" → `/connections/<project>?source=url`
  (the preselect `ConnectionsPage` already reads). They are links, styled as the source tiles with
  an arrow that says they leave the page. The importer is already editors-only (`EditorsOnly`).
- **The Data header and its empty state** gain "Connect a database" → `/connections/<project>`,
  beside Import file and Paste data, and the sentences name databases too.
- **Home → New → Dashboard** opens `/analyses?project=<id>&new=1`, the wizard, as the palette does.
- **Dashboards** gets "Create dashboard" (→ the same wizard) beside "Publish…" in the header and in
  the empty state. Publish stays the primary; Create is secondary.

## 5. Grouped nav

`web/src/app/navGroups.ts` places each `NAV` route; `nav.ts` stays untouched (append-only).

| group | routes |
|---|---|
| View | Home, Explore, Dashboards, Reports |
| Build | Data, Connections, Pipelines, Visuals, Analyses, Analytics |
| (foot) | Settings, Admin, Trash — `bottom: true` in `nav.ts`, as today |

The rail renders each group under a small label (11px, uppercase, tracked, `--muted`) in a
`role="group"` named by it. The rail is icons only at every width and slides its names out over
the page on hover or keyboard focus; closed, each label gives way to a hairline. Home is the
exception: wider than 900px, the rail stays open beside the page with its names, and hover does nothing. A test
fails if a main `NAV` entry is in no group or in two, or a group names a route `NAV` does not have
(negative control: a planted entry).

## Decisions made where the spec left room

1. **The gate covers the presets, the print box and the built-ins, not just theme.css.** They
   redefine the same text tokens with the same failing values, and dashboards are where KPI names
   and deltas live. The parser is the same; the cost is a loop.
2. **The gate reads the chip rules, not a list of assumed pairs.** Badge, the grid chips and the
   Data type chip are read from their stylesheets with a tiny evaluator (`var()` with fallbacks,
   `rgba()`, `color-mix(in srgb, …)`), so a chip restyled with a failing ink fails the test.
3. **Tone inks are tokens, `--accent-text` follows the brand.** Light `--accent-text` falls back from
   `--brand-accent-2` and dark from `--brand-dk-accent-fg` (the brand ramp's "accent as text",
   computed but unused until now), so a workspace accent keeps its hue in a Badge. The gate checks
   the app's own values; a brand's are walked by `palette.ts` on their tint over every surface. The accent axes of a dashboard
   preset do not redefine `--accent-text` (its `auto` axis paints light values on a dark app, an
   existing gap the chart-palette review owns), so a teal dashboard's accent Badge stays blue.
4. **The dark sheet's accent ink is #8cbaff, not the desktop's #7cb0ff**: the smallest change that
   clears the teal and slate axes' tints (see above). The app's own dark keeps #7cb0ff.
5. **Step 1 lands the Badge and chip colours.** The spec's gate includes the Badge tones, so the
   inks it measures go in with it (Step 1); Step 2 is the faint-to-dim sweep and the dark surfaces.
6. **One header component, two frames** (`Page` and `PageHead`), not a `variant` prop: an editor
   keeps its full-height frame and its bar's surface, and passes them as a class.
7. **"At most one primary" is checked at run time**, in every build, as a `console.error`: the e2e
   harness fails any page that logs one, so the rule holds on every screen the suite visits, not
   only in the Vitest.
8. **The crumb is a quiet link, not a ghost button**: a 28px ghost button above a 20px title was the
   heaviest thing in most headers. 13px `--muted` text and a 16px arrow, `--text` on a `--surface-2`
   fill on hover, a 24px hit area, its arrow on the title's left edge.
9. **`useCameFrom` reads router state**, set by the openers that are not the parent. No history
   sniffing: a crumb must name its target, and only the opener knows the name.
10. **`BackLink` is exported** for the phone dashboard's icon-only bar, so even that back link comes
    from `blocks.tsx`; the phone keeps its 44px target and its "Back to Analyses" name.
11. **The nav's foot keeps its order** (Settings, Admin, Trash, as `nav.ts` lists them); "the bottom
    stays as it is" wins over the spec's listing order.
12. **The tone inks are theme tokens too.** A preset that redefines `--ok` must redefine `--ok-text`
    (`scripts/test-dashboardStyleCss` holds every preset to the dark theme's token set), so the four
    inks join `AXIS_TOKENS` (`src/analysis/themeModel.ts`) and the browser's copy, and each built-in
    theme carries them. A custom theme gets them for its own lightness, never the app's: `deriveBase`
    and `deriveAccent` derive the four (the accent's from its own hue, the tones from the app's),
    walked to 4.5:1 on each tint over every surface the theme carries; a theme saved before them
    gets the missing ones where it is drawn (`themeStyleVars`, used by the dashboard sheet and the
    Settings preview), and `themeWarnings` (both copies) measures each ink on its tint (review round).
13. **A header picker has no visible label.** The dataset pickers in the visual builder's and the
    analytics workbenches' headers take `aria-label="Dataset"`, so they are a control's height and sit
    on the title's line beside the buttons; the dataset is what they show.
14. **The crumb reached further than the spec's list**, where a page had no way back at all: version
    history goes back to its record, an input table to its dataset, Metrics and Captures (reached
    from the Data header) to Data, the scenarios list to Analytics. Get started's "Create a
    dashboard" opens the wizard too, for the same reason Home → New → Dashboard does.
15. **A header's primary sits last**, on the right edge: the Data header's order is Metrics, Paste
    data, Connect a database, Import file.
16. **A list page's primary action is the header's** (found looking at the screenshots): Captures,
    Metrics, Analyses, Visuals and Scenarios each had theirs on a bar of its own under the header,
    a second header in effect. It moves into `actions`, and the list's count becomes a chip after
    the title. With nothing in the list, the empty state holds the create door and the header does
    not repeat it (as the Data page already did).
17. **An editable name is as wide as the name** (`field-sizing: content`, falling back to the fixed
    width where unsupported), so a story's, scorecard's or scenario's save status sits right after
    it instead of 420px away.
18. **`deriveBase` walks the quiet text tones** (review round): `--muted` and `--text-dim` to 4.5:1,
    `--text-faint` to 3:1, on every surface the theme derives, starting from the old mixes. A theme
    built in the editor is now on the floor; a value typed into a token directly is still advice.
19. **The contrast gate records one pre-existing pair** instead of hiding it: an `auto` sheet in a
    dark app carries the light accent axis, so a teal brand's light ramp draws the date chip at 4.31
    on the dark surface-3. `KNOWN` in `theme.contrast.test.ts` holds it exactly, so its fix (or a new
    failure) shows.
20. **The screens merged from SSO lifecycle and notifications follow the same contract.** API tokens
    is a page under Settings: a crumb back to Settings, its count after the title, and New token in
    the header in every state (the empty state does not repeat it). Admin → People's identity
    provider groups panel is a section of People, so its Map a group is a secondary beside People's
    one primary, Invite people. The @mention chip and Home's new-mentions count use `--accent-text`
    on the tint, the picker's error note `--error-text`; a picked option sits on `--surface-3` and a
    new mention card is marked by its line and dot rather than a tint, so their quiet words keep 4.5:1.
    The contrast gate reads those rules from `Mentions.module.css`.

## Steps

1. The tokens and the gate: theme.css, the presets, the print box, the built-ins, the Badge and chip
   inks, `theme.contrast.test.ts`.
2. The faint usages that carry words move to dim; `BRAND_DARK_SURFACES` to today's surfaces.
3. Reduced motion in the fixture's context; the one-offs go.
4. `Page`/`PageHead`/`BackLink`/`useCameFrom` and their Vitest, then one commit per area: Data
   (dataset, prepare, captures, data header, live), reports (story, scorecard, builder), analyses
   (editor head, phone head, metric tree, rebuild), analytics (workbenches, SQL, events, scenarios),
   connections and visuals, Explore; then the back-link guard.
5. The doors, with a Vitest each (an editor sees it, a viewer does not) and two e2e.
6. The nav groups, the rail, `Shell.test.tsx` in group order.
7. Every e2e screenshot re-taken and looked at, light and dark.

## Follow-ups (deferred)

- `src/analysis/dashboardExport.ts` carries its own copy of the old text tokens for the exported
  HTML and `/p/` pages; raising them belongs with the `/p/` page work.
- Custom themes: `deriveBase` now walks the quiet text tones and the inks to the floor (decisions 12
  and 18), but a value typed straight into a token is only warned about (advice, not a gate), and
  `dashboardExport.ts`'s theme block does not yet fill a saved theme's missing inks.
- About 245 `color: var(--accent)` declarations use the fill colour as text. Many are icons (3:1 is
  enough); the words among them should move to `--accent-text` one by one.
- An `auto` dashboard sheet in a dark app carries the light accent axis (`styleClass`), so a brand's
  light ramp is drawn on dark surfaces (decision 19); the chart-palette review owns it.
