# The section hero, and why it is gone

Visuals carried `.ws-hero`: a full-bleed blue-to-purple gradient block, roughly a quarter of the
panel high, reading *"One chart, saved once, used everywhere. Pick a dataset, describe what you want
to see…"*. It was the loudest surface in a product that is otherwise white, grey and a single blue
accent, and its content was a pitch.

Its display rule was the problem:

```js
hero.hidden = items.length === 0 || vizHeroDismissed();
```

It appeared **only alongside real content** and **never on the empty state**. So a user with three
saved visuals was told what visuals are for, above their three visuals, until they dismissed it —
and a user with none, the only person who might have wanted the explanation, never saw it.

## The decision

Two honest options were on the table: restyle the banner to look like the rest of the app, or move
the teach to the empty state. **The empty state won**, and looking at the two states side by side is
what settled it rather than reading the code.

`#viz-empty` was already the same teach: the same glyph-cluster art (both hosts share
`.viz-glyph-art`), the same "what a visual is" sentence, the same `+ New visual` primary action, plus
an Assistant door and a band of the project's real datasets. The hero was not a companion to that —
it was a **second copy of it, fired at the wrong moment**. Restyling it would have produced a
quieter duplicate, which is still a duplicate.

Data and Dashboards already teach the correct way: header → content when there are records, and a
`.ws-empty` card carrying the explanation when there are none. Visuals was the only outlier. So the
change is a deletion that makes three sections behave alike, not a new pattern.

One sentence the banner owned and the empty state did not — *"Every number is computed by the
app."*, the product's core principle — was folded into the empty-state copy. The teach is not lost,
it is in the one place where "here is what this section is for" **is** the content.

## The Analyses twin

There isn't one, any more. `.ws-hero` had exactly one instance in the app: `#viz-hero` in Visuals.
The comments in `index.html` and `vizGallery.ts` claiming "the same `.ws-hero` the Analyses section
uses" were stale — Analyses (now Dashboards) lost its banner in an earlier round and kept only the
**bar motif** (`.ws-hero-bar`), which its empty state and its blank-sheet dashboard cards still draw.

That motif outlived the component it was named for, so it is renamed `.ws-bars` / `.ws-bar` and given
theme tokens instead of the white-on-gradient values it needed inside the banner. Rendering is
unchanged in both places (see the `dashboards-empty` and populated shots). Everything else the hero
owned — the gradient, the copy block, the white-on-colour button overrides, the white glyph
overrides — is deleted rather than left behind as dead rules.

`vizHeroDismissed` / the `vizHeroDismissed` localStorage key went with it. Nobody sees the banner
now, so a user who had dismissed it stays exactly where they were.

## Screenshots

1440×900, captured from the real app via Playwright (`_electron.launch`, fresh `--user-data-dir`,
splash waited out). The bundled sample seeds the populated project; a second bare project gives the
empty state. Zero renderer console errors in the "after" run.

| | Visuals | Dashboards |
|---|---|---|
| populated, light | `before/after-visuals-populated-light.png` | `before/after-dashboards-populated-light.png` |
| populated, dark | `before/after-visuals-populated-dark.png` | `before/after-dashboards-populated-dark.png` |
| empty, light | `before/after-visuals-empty-light.png` | `before/after-dashboards-empty-light.png` |
| empty, dark | `before/after-visuals-empty-dark.png` | `before/after-dashboards-empty-dark.png` |

`before-visuals-populated-*` is the only pair that differs — which is the point: every other surface
was already correct, and the banner was the one thing out of step.

## What holds it

`scripts/smoke-section-hero.js` drives the real app and pins the rule on **both** sections, so they
cannot drift apart again: populated Visuals and populated Dashboards show no banner over their
content; it stays gone across a section switch and across a reload (where a "first-run, until
dismissed" banner would come back); both empty states still carry their teach, including the
sentence inherited from the hero; and no `.ws-hero` rule survives in `hub.css`, so the styling half
cannot grow back behind a deleted element.

It is a separate smoke file because `scripts/smoke-app.ts` is at its allowlisted line count and
cannot grow (`.claude/rules/file-size.md`). Verified non-inert: re-adding a bare
`<div class="ws-hero" id="viz-hero">` and one `.ws-hero` CSS rule flips 7 of its 10 assertions to
FAIL.
