// The AI draft review dialog, on a synthetic Phase E envelope.
//
// Split out of smoke-app.ts (see that file's banner). `analysis:draft` needs a
// configured model, which a smoke run has not got, so this dialog would
// otherwise ship never having been rendered once. It is pure DOM, so it can be
// opened directly with the exact envelope shape Phase E returns —
// { rationale, sheets[].visuals[], calculatedFields, dropped[] } — and asserted
// the way everything else is: by what paints.
//
// Two of these assertions are ORDER and OVERFLOW, and neither survives outside
// a laid-out page. What the app DROPPED must come above the preview charts: at
// its natural height a chart pushes the drop list below the fold, and a list of
// the model's mistakes the user has to scroll to find defeats the point — they
// approve having seen only the parts that worked. And the preview chart must
// stay inside its box; `.cv-viz-area` sizes its canvas wrapper against the
// viewport, so unclipped it printed through the card below, which every DOM
// assertion passed and one screenshot caught.
//
//   npm run build:ts && node scripts/smoke-draft-review.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import {
  launchSmoke, reloadSmoke, seedProject, openProject, domDriver, finishSmoke,
} from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

async function main(): Promise<void> {
  const smoke = await launchSmoke('draft-review');
  const { win, errors, shotDir } = smoke;

  const r = await seedProject(smoke.app, { rows: 5_000 });
  await reloadSmoke(smoke);
  await openProject(win, r.projectId);

  const { clickExact } = domDriver(win);
  ok('the Dashboards section is in the workspace nav', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);

  // ── The AI draft review dialog, on a synthetic Phase E envelope ───────────
  // `analysis:draft` needs a configured model, which a smoke run has not got, so
  // the review dialog would otherwise ship never having been rendered once. It
  // is pure DOM, so it can be opened directly with the exact envelope shape
  // Phase E returns — { rationale, sheets[].visuals[], calculatedFields,
  // dropped[] } — and asserted the way everything else here is: by what paints.
  await win.evaluate(() => {
    (window as any).__draftResult = 'pending';
    (window as any)
      .anDraftReviewModal({
        ok: true,
        name: 'Regional performance',
        rationale: 'Revenue is concentrated in a few regions, so the first sheet leads with the split.',
        calculatedFields: [{ name: 'margin', formula: 'revenue - cost' }],
        sheets: [
          {
            name: 'Overview',
            visuals: [
              {
                name: 'Revenue by region',
                chartType: 'column',
                data: {
                  labels: ['North', 'South', 'East'],
                  series: [{ name: 'sum of amount', values: [3, 1, 2] }],
                },
              },
              {
                name: 'Margin trend',
                chartType: 'line',
                data: null,
                note: 'Needs the calculated field “margin”, which does not exist yet.',
              },
            ],
          },
        ],
        dropped: [
          { kind: 'chart_type', where: 'sheets[0].visuals[2]', message: '“spiral” is not a chart type Ordinate has.' },
          { kind: 'formula', where: 'calculatedFields[1]', message: 'The formula does not compile.' },
        ],
      })
      .then((v: boolean) => { (window as any).__draftResult = v; });
  });
  await win.waitForTimeout(1500);
  const review = await win.evaluate(() => {
    const modal = document.querySelector('.an-draft-modal') as HTMLElement | null;
    const viz = document.querySelector('.an-draft-viz') as HTMLElement | null;
    const note = document.querySelector('.an-draft-note--why') as HTMLElement | null;
    const dropped = [...document.querySelectorAll('.an-draft-dropped')].filter(
      (e) => (e as HTMLElement).offsetParent !== null,
    );
    const mr = modal?.getBoundingClientRect();
    const vr = viz?.getBoundingClientRect();
    // Where the drop list sits RELATIVE to the first preview chart. At its
    // natural height a chart pushes the drop list below the fold, and a list of
    // the model's mistakes the user must scroll to find defeats the point:
    // they approve having seen only the parts that worked.
    const firstDropTop = dropped.length
      ? Math.round((dropped[0] as HTMLElement).getBoundingClientRect().top) : -1;
    return {
      firstDropTop,
      firstVizTop: Math.round(vr?.top ?? 1e9),
      modalW: Math.round(mr?.width || 0),
      modalH: Math.round(mr?.height || 0),
      vizH: Math.round(vr?.height || 0),
      vizDrew: !!viz?.querySelector('canvas'),
      // The preview chart must stay INSIDE its box. `.cv-viz-area` sizes its
      // canvas wrapper against the viewport, so unclipped it printed through
      // the card below — a bug every DOM assertion passed and the screenshot
      // caught in one look.
      vizOverflow: (() => {
        const cv = viz?.querySelector('canvas') as HTMLElement | null;
        if (!cv || !vr) return 0;
        const cr = cv.getBoundingClientRect();
        return Math.round(Math.max(0, cr.bottom - vr.bottom));
      })(),
      noteText: (note?.textContent || '').trim(),
      noteVisible: !!note && note.offsetParent !== null,
      droppedCount: dropped.length,
      droppedText: dropped.map((d) => (d.textContent || '').trim()).join(' | ').slice(0, 160),
      rationale: (document.querySelector('.an-draft-rationale .ai-interp-body')?.textContent || '').trim().slice(0, 40),
      calc: (document.querySelector('.an-draft-calc-formula')?.textContent || '').trim(),
      createVisible: [...document.querySelectorAll('.an-draft-modal .ws-modal-actions .btn')]
        .some((b) => /Create dashboard/.test(b.textContent || '') && (b as HTMLElement).offsetParent !== null),
      // Nothing may stand in for a figure the app did not compute.
      fakeFigure: /(^|\s)(0|—|N\/A)(\s|$)/.test(note?.textContent || ''),
    };
  });
  // Order, not just presence: dropped entries must come BEFORE the previews.
  ok('what was dropped is shown above the preview charts, not below them',
     review.firstDropTop >= 0 && review.firstDropTop < review.firstVizTop,
     `dropTop=${review.firstDropTop} vizTop=${review.firstVizTop}`);
  ok('the draft review dialog paints at a real size', review.modalW > 400 && review.modalH > 200,
     `${review.modalW}x${review.modalH}`);
  ok('a previewed visual renders its app-computed data as a chart',
     review.vizDrew && review.vizH > 100, `canvas=${review.vizDrew} height=${review.vizH}`);
  ok('and the preview chart stays inside its box (no printing through the next card)',
     review.vizOverflow === 0, `${review.vizOverflow}px past the bottom`);
  ok('a null-data visual shows its note instead, and no substituted figure',
     review.noteVisible && /Needs the calculated field/.test(review.noteText) && !review.fakeFigure,
     review.noteText.slice(0, 80));
  ok('everything the app DROPPED is shown, with its envelope path',
     review.droppedCount === 2 && /sheets\[0\]\.visuals\[2\]/.test(review.droppedText),
     review.droppedText);
  ok('the rationale and calculated fields are shown',
     !!review.rationale && review.calc === 'revenue - cost',
     `${review.rationale} / ${review.calc}`);
  ok('the dialog offers Create', review.createVisible);

  const draftShot = path.join(shotDir, 'draft-review.png');
  await win.screenshot({ path: draftShot });
  ok('draft review screenshot captured', fs.existsSync(draftShot) && fs.statSync(draftShot).size > 5000,
     `${Math.round(fs.statSync(draftShot).size / 1024)} KB -> ${draftShot}`);

  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.an-draft-modal .ws-modal-actions .btn')].find((x) =>
      /Discard/.test(x.textContent || ''),
    ) as HTMLElement | undefined;
    if (b) b.click();
  });
  await win.waitForTimeout(600);
  const discarded = await win.evaluate(() => ({
    result: (window as any).__draftResult,
    gone: !document.querySelector('.an-draft-modal'),
  }));
  ok('Discard resolves false and tears the dialog down',
     discarded.result === false && discarded.gone, JSON.stringify(discarded));

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await smoke.close();
}

main()
  .then(() => finishSmoke('draft-review', failureCount()))
  .catch((err) => {
    console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  });
