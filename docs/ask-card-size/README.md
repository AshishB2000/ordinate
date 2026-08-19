# Ask proposal card — chart tile sizing

A follow-up to PR #104 (feat/ask-actions). The one proposal engine
(`renderer/hub/dockPropose.ts`) mounts the **same** chart card into two places:
the ~340px dock panel (`#dk-messages`) and the full-width Ask transcript
(`#xp-messages`). It looked right in the dock and oversized in Ask.

## Cause

The chart canvas lives in a shared `.cv-canvas-wrap`, whose height is
`clamp(300px, 44vh, 480px)` — **≈396px at a 900px-tall window**, a viewport-scaled
box tuned for a full analysis panel. That height is the same regardless of column
width, so in the wide Ask column the proposal card ballooned past half the
viewport, grew its **own inner scrollbar**, and — because the transcript scrolls to
the bottom when the card mounts — pushed the question and answer bubbles the card
belongs to **off the top of the screen**.

## Fix (CSS only, one rule)

Scope a compact fixed height to the Ask mount's canvas box, leaving the dock's
shared sizing untouched:

```css
#xp-messages .dk-proposal-chart .cv-canvas-wrap {
  height: 240px;
}
```

Chart.js is `responsive: true, maintainAspectRatio: false` (`chartRender.ts`), so it
renders the canvas to that box's height — compact, not clipped. Two dead ends ruled
out along the way (both confirmed against the real render, not by eyeballing CSS):

- `max-height` on the tile letterboxed: the canvas kept its 396px height and
  **overflowed** the clipped tile onto the action row (measured canvas bottom 670
  vs tile bottom 514). A bare cap gives Chart.js no definite height to render into.
- A `height` on the outer `.dk-proposal-chart` tile did nothing: Chart.js measures
  the inner `.cv-canvas-wrap`, whose own fixed `clamp()` height wins. The rule has
  to land on that wrapper.

The rule is scoped to `#xp-messages`, so the dock is untouched by construction.

## Measured, real app (xvfb, 1440×900, splash removed)

| | chart tile | card height | inner scroll | answer visible | dock tile |
|---|---|---|---|---|---|
| **before** | 671×**396** | 523px | **141px** | (scrolled off) | 281×396 |
| **after**  | 686×**240** | 367px | **0px** | **yes** | 281×396 |

The action row (Save as visual · Turn into analysis · Dismiss) stays fully visible,
the chart canvas still renders in both mounts, and the dock tile is identical
before and after. No renderer console errors.

## Screenshots

Real app, light + dark, at 1440×900.

- `before-ask-{light,dark}.png` — the oversized card with its own scrollbar; the
  question/answer bubbles are gone off the top.
- `after-ask-{light,dark}.png` — the question and answer bubbles are both visible
  above a compact chart card.
- `before-dock-{light,dark}.png` / `after-dock-{light,dark}.png` — the dock mount,
  unchanged.
