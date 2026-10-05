// roundLabelFits — the rule that decides whether a pie/donut slice may print its
// own label (./labelText.ts).
//
// WHY THIS FILE EXISTS. The old rule was `frac >= 0.06`: a share of the TOTAL,
// which says nothing about pixels. On a dashboard card's ~150px donut a 6% slice
// is a few pixels wide, and "Technology" in 10px type was drawn straight across
// the ring and out the other side.
//
// The replacement asks whether the label's own box — a rectangle centred on the
// slice's mid-radius, mid-angle point — has all four corners inside the annular
// sector. ORIENTATION IS THE POINT. A first attempt compared the text width to
// the slice's chord, which is rotation-independent; the label is not, because it
// is drawn horizontally. That version fixed the pie and left the donut exactly
// as broken, so the cases below pin slices at several positions around the ring,
// not just several sizes.
//
// That makes it pure arithmetic, and pure arithmetic is testable without a
// canvas. The ONE thing this cannot cover is `ctx.measureText`, which the caller
// does; the numbers below are real measurements of 10px Inter taken from the
// running app, named so it is obvious when they are the input rather than the
// thing under test.
//
// The geometry is likewise real — MEASURED out of the running app by building
// the sample's category donut into a sized host and reading the arcs back, not
// derived on paper. The first draft of this file did derive it on paper, got the
// ring thickness badly wrong, and produced expectations that argued for the
// wrong rule. The two sizes that matter:
//   - a 210x150 gallery/dashboard tile → inner 31, outer 51  (a 20px ring)
//   - a 700x460 full-size chart        → inner 127, outer 206 (a 79px ring)
// and the real 10px-Inter widths of the sample's own category names.
//
// Ported from scripts/test-roundLabels.ts at the T8.1 cutover, where the same
// checks pinned the desktop's chartValueLabels.js.

import { describe, expect, it } from 'vitest';
import { roundLabelFits as portRoundLabelFits } from './labelText';

describe("roundLabelFits", () => {
  it('every check holds', () => {
    const fails: string[] = [];
    const ok = (label: string, cond: boolean, extra?: unknown): void => {
      if (!cond) fails.push(label + (extra === undefined ? '' : '  ' + String(extra)));
    };
    const failureCount = (): number => fails.length;
    const roundLabelFits: (
      g: { innerRadius: number; outerRadius: number; startAngle: number; endAngle: number },
      textWidth: number, textHeight: number,
    ) => boolean = portRoundLabelFits;

    ok('the module exposes roundLabelFits', typeof roundLabelFits === 'function');

    const LH = 12;          // the plugin's line height
    const TAU = Math.PI * 2;

    /** A slice of `frac` of the circle starting at `atFrac` around it, at the two
     *  MEASURED sizes. Orientation is a parameter because the label is drawn
     *  horizontally: where a slice sits decides its left-to-right room. */
    const tile = (frac: number, atFrac = 0) =>
      ({ innerRadius: 31, outerRadius: 51, startAngle: TAU * atFrac, endAngle: TAU * (atFrac + frac) });
    const full = (frac: number, atFrac = 0) =>
      ({ innerRadius: 127, outerRadius: 206, startAngle: TAU * atFrac, endAngle: TAU * (atFrac + frac) });

    // Measured widths of the sample's own categories in 10px Inter, 600 weight.
    const W_TECHNOLOGY = 58;
    const W_FURNITURE = 46;
    const W_OFFICE = 77;       // "Office Supplies", before the caller's 14-char clip

    /** Every orientation on the ring, so nothing passes by sitting at a lucky angle. */
    const AROUND = [0, 0.12, 0.25, 0.37, 0.5, 0.62, 0.75, 0.87];

    // ── THE BUG ────────────────────────────────────────────────────────────────
    // A 20px ring cannot carry 10px type in any direction — the reported case. All
    // of these passed the old `frac >= 0.06` gate and were drawn across the ring.
    ok('tile: a 30% slice cannot hold "Technology" at ANY orientation',
       AROUND.every((at) => roundLabelFits(tile(0.30, at), W_TECHNOLOGY, LH) === false));
    ok('tile: nor the shorter "Furniture"',
       AROUND.every((at) => roundLabelFits(tile(0.30, at), W_FURNITURE, LH) === false));
    ok('tile: nor "Office Supplies"',
       AROUND.every((at) => roundLabelFits(tile(0.45, at), W_OFFICE, LH) === false));
    ok('tile: not even the whole circle as one slice',
       roundLabelFits(tile(1), W_FURNITURE, LH) === false);

    // ── AND THE OTHER HALF: full size must not go quiet ────────────────────────
    // A 79px ring carries a name comfortably, which is why this rule does not cost
    // the full-size chart its labels. If these ever flip, the gate got too strict.
    ok('full: a 30% slice holds "Technology" at every orientation',
       AROUND.every((at) => roundLabelFits(full(0.30, at), W_TECHNOLOGY, LH) === true));
    ok('full: …and "Furniture"',
       AROUND.every((at) => roundLabelFits(full(0.30, at), W_FURNITURE, LH) === true));
    ok('full: …and a name over its value, two lines',
       AROUND.every((at) => roundLabelFits(full(0.30, at), W_TECHNOLOGY, 2 * LH) === true));
    ok('full: a single-category donut keeps its one label',
       roundLabelFits(full(1), W_TECHNOLOGY, LH) === true);

    // A thin slice at FULL size has always overflowed too — the same bug, rarer.
    ok('full: a 2% sliver still cannot hold a name',
       AROUND.every((at) => roundLabelFits(full(0.02, at), W_TECHNOLOGY, LH) === false));

    // ── Angular containment: never bleed into the NEIGHBOUR ────────────────────
    // The visually worst failure is a label crossing into the next slice, and it is
    // the one a radius-only test would miss.
    //
    // A THIN WEDGE IS ORIENTATION-DEPENDENT, and correctly so. Canvas angles start
    // at 3 o'clock and run clockwise, so a 4% wedge centred at 3 or 9 o'clock has
    // the text running OUTWARD ALONG it — 66px of label down a 79px ring, which
    // genuinely fits and genuinely looks fine. The same wedge at 6 or 12 o'clock has
    // the text running ACROSS a 42px chord and must be refused. Asserting "refused
    // everywhere" here would have been asserting a bug.
    const wedgeAt = (midRad: number, frac = 0.04) => ({
      innerRadius: 127, outerRadius: 206,
      startAngle: midRad - TAU * frac / 2, endAngle: midRad + TAU * frac / 2,
    });
    ok('full: a 4% wedge is refused where the text would run ACROSS it (6 and 12 o\'clock)',
       roundLabelFits(wedgeAt(Math.PI / 2), W_TECHNOLOGY, LH) === false
       && roundLabelFits(wedgeAt(3 * Math.PI / 2), W_TECHNOLOGY, LH) === false);
    ok('…and allowed where it runs ALONG it (3 and 9 o\'clock)',
       roundLabelFits(wedgeAt(0), W_TECHNOLOGY, LH) === true
       && roundLabelFits(wedgeAt(Math.PI), W_TECHNOLOGY, LH) === true);
    ok('…while a wedge too thin for the text in EITHER direction is always refused',
       [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2].every((m) =>
         roundLabelFits(wedgeAt(m, 0.004), W_TECHNOLOGY, LH) === false));

    // ── Radial containment: the ring's thickness is checked too ────────────────
    ok('a wide slice with a thin ring rejects a two-line label',
       roundLabelFits({ innerRadius: 120, outerRadius: 140, startAngle: 0, endAngle: TAU * 0.5 },
                      20, 2 * LH) === false);
    ok('…and accepts the same label on one line',
       roundLabelFits({ innerRadius: 120, outerRadius: 140, startAngle: 0, endAngle: TAU * 0.5 },
                      20, LH) === true);

    // ── A pie is a donut with innerRadius 0 ────────────────────────────────────
    // Its label sits at half the radius, where the wedge is narrower than the ring
    // of a donut of the same size — so a pie is quieter, correctly.
    const pie = (frac: number, atFrac = 0) =>
      ({ innerRadius: 0, outerRadius: 206, startAngle: TAU * atFrac, endAngle: TAU * (atFrac + frac) });
    ok('a roomy 30% pie slice holds its name',
       AROUND.every((at) => roundLabelFits(pie(0.30, at), W_TECHNOLOGY, LH) === true));
    ok('a full-circle pie keeps its label', roundLabelFits(pie(1), W_TECHNOLOGY, LH) === true);
    ok('…and a pie sliver refuses',
       AROUND.every((at) => roundLabelFits(pie(0.01, at), W_TECHNOLOGY, LH) === false));

    // ── Degenerate geometry never throws and never draws ───────────────────────
    for (const [name, g, w, h] of [
      ['zero radius', { innerRadius: 0, outerRadius: 0, startAngle: 0, endAngle: TAU * 0.5 }, 10, LH],
      ['inner past outer', { innerRadius: 80, outerRadius: 40, startAngle: 0, endAngle: TAU * 0.5 }, 10, LH],
      ['zero angle', { innerRadius: 30, outerRadius: 60, startAngle: 1, endAngle: 1 }, 10, LH],
      ['zero text', { innerRadius: 30, outerRadius: 60, startAngle: 0, endAngle: TAU * 0.5 }, 0, LH],
      ['NaN geometry', { innerRadius: NaN, outerRadius: NaN, startAngle: NaN, endAngle: NaN }, 10, LH],
      ['NaN text', { innerRadius: 30, outerRadius: 60, startAngle: 0, endAngle: TAU * 0.5 }, NaN, LH],
    ] as [string, any, number, number][]) {
      let threw = false;
      let out: boolean | null = null;
      try { out = roundLabelFits(g, w, h); } catch (_) { threw = true; }
      ok('degenerate (' + name + ') returns false without throwing',
         !threw && out === false, threw ? 'threw' : String(out));
    }

    expect(fails).toEqual([]);
    void failureCount;
  });
});
