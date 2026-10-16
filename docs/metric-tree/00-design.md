# Metric tree — "why did this number move" in one picture

## What you will see when this is done

Open **Data → Metrics**, pick **Revenue**, choose **Open tree**. The page shows one picture:

```
                         ┌──────────────────────────┐
                         │ Revenue          $182K   │
                         │ was $164K · +$18.4K +11% │
                         │ ╱╲╱‾‾╲╱ (12 months)      │
                         └────────────┬─────────────┘
                     ┏━━━━━━━━━━━━━━━━┻───────────────────┐   ← the branch that explains most is thicker and tinted
          ┌──────────┴──────────┐               ┌─────────┴───────────┐
          │ Orders        1,214 │               │ Avg order value $150 │
          │ +142 +13%           │               │ −$2.10 −1.4%         │
          │ explains +$21.1K    │               │ explains −$2.7K      │
          │ 115% of the change  │               │ −15% of the change   │
          └──────────┬──────────┘               └──────────────────────┘
        ┏━━━━━━━━━━━━┻━━━┯━━━━━━━━━━┯━━━━━━━━━┓  split by region
      West ▲ +$12K   East +$5K    Central +$3K   South +$1K
```

- **Period** (top bar): "Latest month in the data" by default (the newest *closed* month — the same
  month the Metrics table's sparkline ends on), or Latest quarter / Last month / Last quarter /
  Last 30 days / Year to date / custom dates. Beside it the **same Compare control a dashboard
  uses** — vs previous period / vs same period last year / vs custom dates.
- A **headline sentence** the server writes: *"Revenue rose $18.4K (+11.2%) vs previous period;
  Orders explains 115% of it, led by West."*
- Each **node card**: name, current figure, previous figure, change (absolute and %), a 12-month
  sparkline, and — for every node below the root — its **contribution** to its parent's change
  (signed, in the parent's units, and as a share of the parent's change). Segments of a ratio
  metric also show **mix** and **rate**.
- The **lead branch** — at each level, the child that pushed hardest in the direction the parent
  moved — is tinted (green when that is good news by the metric's direction, red when bad, accent
  when the metric has no direction) with a thicker connector, from the root down.
- Nodes **expand and collapse** (click the chevron, or the keyboard: ↑ ↓ move, → opens / goes to
  the first child, ← closes / goes to the parent, Enter toggles, Home / End). A node whose parts do
  not add up to it shows a **"Not explained by its parts"** row with the residual — never a fudge.
- **Edit tree** opens the editor: each node says how it breaks down. "Break down…" offers
  *Sum* (A + B + …, any part can be subtracted), *Product* (A × B …), *Ratio* (A ÷ B) or *Split by
  a column*. Suggestions come first, read from the project's formulas: Revenue gets "Orders × Avg
  order value" because Avg order value is `[Revenue] / [Orders]`. Saved on the metric's record.
- **Add to a dashboard**: the "Metric tree" card in the dashboard's Add menu. It follows the
  sheet's date filter and the sheet's Compare (else its own, default vs previous period), and the
  sheet's other filters. Published (`/p/`), the card is a numbers table of the tree with the
  headline as its caption.
- Empty, loading (skeleton tree) and error states, light and dark; a Live metric works (figures
  through the Live doors) with no sparklines.

## Decisions (made here, not asked — the user was away)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Where is the tree stored? | `tree` on the **metric record** (`src/analysis/metrics.ts` `normalize`), sanitized by `sanitizeTree`. **No migration**; 0018 unused. | Records already go through `recordFs` (JSON or the `records` row); a tree is part of what the metric *means*. |
| D2 | What may a child be? | A saved metric **on the same dataset** as the root. Splits are by a **text** column of that dataset. | The period is moved on the root dataset's date column (`compareScope`); a child on another dataset has no such column. |
| D3 | Limits | depth ≤ 4, ≤ 40 nodes, sum 2–8 parts, product 2–4, ratio exactly 2, a metric at most once on any root→leaf path (no cycles). | Keeps the Shapley sum ≤ 2⁴ coalitions and the picture readable. |
| D4 | Product/ratio decomposition | **Shapley value** of the relation (below), not LMDI. | Exact additivity in real arithmetic with **no** special case for zero or a sign change; LMDI (log-mean) is undefined at both and would need the fallback anyway. |
| D5 | Parts that don't add up | Contributions are computed from the children; the gap to the parent's real change is shown as its own row, "Not explained by its parts". | The tree never redistributes a residual into a child — that would be an invented contribution. |
| D6 | Dimension split values | One **chart-door** (`vizDataFor`) call per period over the metric's driver operands (`driverShape`), so a Live dataset works and the resident fast path is used. | "Figures go through the doors." |
| D7 | Split contribution | additive metric → the segment's own change; ratio metric (Margin %, AOV, any avg) → the midpoint **mix + rate** effect of `drivers.memberEffects` (the key-drivers math, reused). `min`/`max` → values and changes, no contributions, with a sentence. | The same identity Key drivers already uses and tests. |
| D8 | Segments shown | Top 6 by \|contribution\|, then "Other (n)" (its contribution = Σ of the rest; its value recomputed from the summed operands). A column with more than 50 values is refused (the chart door folds past 50, and folds per period). | Readable cards; no misaligned buckets. |
| D9 | Default period | Latest closed month in the data (last label of the root's monthly series). A Live metric (no series) defaults to "Last month". | The sample (2023–24) has nothing in "last month"; data-derived is what a reader expects. |
| D10 | Lead branch | At each node, the child with the largest `contribution × sign(parent change)`; ties → editor order. None when the parent did not change. | "Explains most of the change" — the direction the parent actually went. |
| D11 | Percent-format metrics | Change in **points** ("+1.2 pts"), no % change — as `metric:compare` already does. | One convention app-wide. |
| D12 | Assistant | The server writes the headline from engine figures (catalog sentences, `t()`); no model call. A model narration is out of scope for v1. | The sentence is already the narration, and no figure can come from a model. |
| D13 | Dashboard card under "As of" | The card shows the tree for today's periods with a note, like a KPI's Compare (no delta under As of). | Same rule as `kpiCompare`. |

## The math (`src/analysis/metricTreeMath.ts`, pure)

Notation: a node's figure is `y`, previous period `y⁰`, current `y¹`, change `Δy = y¹ − y⁰`. Its
children's figures are `x_i⁰`, `x_i¹`. Every figure arrives from an engine; this file only does
arithmetic on them.

**Relation** `f` of the children:

- sum: `f(x) = Σ s_i·x_i` with `s_i ∈ {+1, −1}`
- product: `f(x) = Π x_i`
- ratio: `f(x) = x_1 / x_2`

**Contribution** of child `i` — its Shapley value in the game where a coalition `S` of children
takes its current values and the rest keep their previous ones:

```
c_i = Σ_{S ⊆ N∖{i}}  |S|! (n−|S|−1)! / n!  ·  [ f(x^{S∪{i}}) − f(x^S) ]
```

Efficiency gives `Σ c_i = f(x¹) − f(x⁰)` exactly (real arithmetic); symmetry gives equal credit to
children that moved alike. Closed forms it reduces to:

- sum: `c_i = s_i·Δx_i` (computed directly — exact in floating point too)
- product of two: `c_A = ΔA·(B⁰+B¹)/2`, `c_B = ΔB·(A⁰+A¹)/2` — the midpoint shift-share key drivers
  uses for mix/rate
- ratio: `c_N = ½[(N¹−N⁰)/D⁰ + (N¹−N⁰)/D¹]`, `c_D = ½[(N⁰/D¹ − N⁰/D⁰) + (N¹/D¹ − N¹/D⁰)]`

**Explicit fallbacks** (each pinned by a test):

1. Zero or sign change in a product: no special case — Shapley is defined (`A: 0 → 10, B: 5 → 7` →
   `c_A = 60`, `c_B = 10`, sum 70 = 70 − 0).
2. A child with no figure (null) in either period → every contribution of that node is null; the
   node says which part has no figure.
3. A ratio whose denominator is 0 in either period → the node's own figure is null (as
   `metric:compare` already reports); in a *mixed* coalition (`N¹/D⁰`) a zero denominator makes
   that coalition's term undefined → contributions null with "the denominator is zero in one
   period". Never a 0 or an Infinity.
4. Parts that don't add up: `residual = Δy − Σ c_i` is shown when `|residual| > 1e-9 · max(1, |Δy|)`
   (float noise below that is not a figure anyone can act on).

**Share** of the parent's change: `c_i / Δy × 100`; null when `Δy = 0`.

**Split** (D7): per segment `k`, the driver operands `a_k` (current) and `b_k` (previous) from the
chart door; `drivers.memberEffects` gives `delta_k` (= own change for additive; = mix + rate for a
ratio, with `mix_k = (w_k¹ − w_k⁰)(r_k¹ + r_k⁰)/2`, `rate_k = (w_k¹ + w_k⁰)/2·(r_k¹ − r_k⁰)`), which
sum to the parent's change because the segments partition the rows (blank is a segment). An avg's
denominator (`ncount`, finite numeric cells) is asked of the door as `count` under a
`>= -9e18` filter, which keeps the finite numbers in both the JS and SQL filter paths (a cell
below −9e18 is the only other thing it drops: the bound must pass the strict number parser and
bind as DuckDB's int64).

## Where the figures come from (the doors)

| Figure | Path |
|---|---|
| a metric node's current / previous / change | `periods.compareMetric` (the KPI Compare) → `resolveMetric` → `computeCardMetric` |
| a split's segments, both periods | `visuals.vizDataFor`, category = the split column, values = the driver operands |
| sparkline (12 closed months, date bounds removed) | `metrics.resolveMetricSeries` — throws for Live, caught: no sparkline |
| formatting | `formatMetricValue` with the metric's own format, on the server |

Never `getDataset` on the request path: `scripts/test-metricTree.ts` spies on it; the Live safety
net (`scripts/test-liveSafetyNet.ts`) calls `metricTree:compute` on a Live metric.

## Surfaces

- RPC (`src/api/metricTree.ts`): `metricTree:compute` (read), `metricTree:save` (write),
  `metricTree:suggest` (read). Tile kind `metricTree` in `analysis:tiles`.
- `src/ipc/metricTree.ts` (handlers), `src/ipc/metricTreeSplit.ts` (the split through the door),
  `src/analysis/metricTree.ts` (shape, sanitizer, suggestions), `metricTreeMath.ts`,
  `metricTreeMessages.ts` (catalog sentences), `metricTreeJs.ts` (the pure-JS reference).
- Web: `web/src/features/analyses/metrics/tree/` — `MetricTreePage` (route
  `/data/metrics/:projectId/:metricId/tree`), `TreeView` (shared with the card), `TreeEditor`,
  `MetricTree.module.css`. Card: `MetricTreeBody`.

## Tests

- `scripts/test-metricTree.ts`: Shapley identities (sum, product of 2/3/4, ratio), zero and sign
  change, null and zero-denominator fallbacks, residual; sanitizer limits and cycles; suggestions;
  **differential** — the server's tree (resident path, > 1,000 rows) against `metricTreeJs` over
  hydrated rows, every figure with `Object.is`; `getDataset` never called by the server path.
  Negative controls: a wrong relation must show a residual; a broken Shapley weight must fail the
  identity check.
- Vitest: `TreeView.test.tsx` (lead path, collapse, keyboard, residual, empty).
- Playwright: `web/e2e/metricTree.e2e.ts` — build a tree in the editor on the sample, read it, add
  the card to a dashboard; screenshots light + dark.
