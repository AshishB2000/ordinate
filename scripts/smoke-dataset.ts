// The dataset page as a LAUNCHPAD, on the real app: the header actions that
// lead out of it, the column-profile panel behind a header click, and the
// Quality tab's completeness table.
//
// What this file exists to catch is the class of failure the unit suites
// structurally cannot see. Every surface here is assembled at runtime from
// four separate sources — `dataset:stats` fetched on open, `visual:data` for
// the distribution, `dataset:median`, and the page the grid is already holding
// — and each one of them fails SILENTLY into a panel that still renders. A
// profile with every figure showing "—" looks like a working panel. So the
// assertions below read the RENDERED TEXT of specific rows and check them
// against the fixture's own definition, never against "something appeared".
//
// FIXTURE NOTE. The task this was written from describes a "Retail orders"
// dataset with a 5-value `region` column topped by "West" and 13 columns. No
// such fixture exists — `smokeFixture.seedProject` seeds "Sales", whose
// `region` is 'region' + (i % 7) over four columns. Asserting the described
// numbers would have meant either inventing a second fixture for one file or
// writing assertions that cannot pass, so these assert the SAME PROPERTIES
// against the real one: seven distinct regions, region0 the modal value, four
// rows in the completeness table.
//
// 5,000 rows, not a million: nothing here stands on the row count, and the
// figures are derived from `i % 7` / `i % 3` either way.
//
//   npm run build:ts && node scripts/smoke-dataset.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, reloadSmoke, seedProject, openProject, domDriver, finishSmoke } from './smokeFixture';

const ROWS = 5_000;

// The fixture's own definition, restated — NOT read back from any code path the
// app uses. `region` is 'region' + (i % 7), so with 5,000 rows region0 and
// region1 hold 715 each and the other five hold 714; `note` is '' when i % 3 is
// 0, which is 1,667 of 5,000 empty and therefore 67% filled.
const REGIONS = 7;
const TOP_REGION = 'region0';
const TOP_REGION_ROWS = 715;
const NOTE_FILLED_PCT = Math.round(((ROWS - Math.ceil(ROWS / 3)) / ROWS) * 100);
const COLUMNS = ['region', 'sku', 'amount', 'note'];

async function main(): Promise<void> {
  const smoke = await launchSmoke('dataset');
  const { win, errors, shotDir } = smoke;

  const r = await seedProject(smoke.app, { rows: ROWS });
  await reloadSmoke(smoke);
  await openProject(win, r.projectId);

  const { clickExact } = domDriver(win);
  ok('the Data section opens', await clickExact('Data'));
  await win.waitForTimeout(1200);

  // ── The list row: the whole row opens it, and it offers a visual ───────────
  const row = await win.evaluate(() => {
    const el = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')]
      .find((x) => /Sales/.test(x.textContent || '')) as HTMLElement | undefined;
    return {
      found: !!el,
      // Present in the DOM at all times (hub.css reveals it on hover with
      // opacity, so a display-based reveal would make this assertion lie).
      hasViz: !!el?.querySelector('.ds-saved-viz'),
      hasCombine: !!el?.querySelector('.ds-saved-combine'),
    };
  });
  ok('the Sales row is listed', row.found);
  ok('the row offers "New visual" beside Combine', row.hasViz && row.hasCombine);

  // Click the row ITSELF, not the name button — the whole row is the target now,
  // and a click on the padding either side of the name used to do nothing.
  const openedByRow = await win.evaluate(() => {
    const el = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')]
      .find((x) => /Sales/.test(x.textContent || '')) as HTMLElement | undefined;
    if (!el) return false;
    el.click();
    return true;
  });
  ok('clicking the row (not the name) opens the dataset', openedByRow);
  await win.waitForTimeout(2500);

  // ── The header: three actions, and the timestamp moved under the title ─────
  const head = await win.evaluate(() => {
    const explorer = document.getElementById('ds-explorer') as HTMLElement | null;
    const ident = document.querySelector('.ds-explorer-ident') as HTMLElement | null;
    const vis = (t: string): boolean => {
      const el = document.getElementById(t) as HTMLElement | null;
      return !!el && !el.hidden && el.getClientRects().length > 0;
    };
    return {
      open: !!explorer && !explorer.hidden,
      title: (document.getElementById('ds-explorer-title')?.textContent || '').trim(),
      visual: vis('ds-act-visual'),
      dashboard: vis('ds-act-dashboard'),
      ask: vis('ds-act-ask'),
      // The freshness line has to be INSIDE the ident block now — that is the
      // whole of "the timestamp moved under the title", and a CSS-only check
      // would pass with it still out on the right.
      freshUnderTitle: !!ident?.querySelector('#ds-explorer-fresh'),
      // Both duplicates are gone from the toolbar.
      explain: !!document.getElementById('ds-explain-btn'),
      prepare: !!document.getElementById('ds-prepare-btn'),
      colsLabel: (document.getElementById('ds-cols-btn')?.textContent || '').trim(),
    };
  });
  ok('the explorer is open on Sales', head.open && head.title === 'Sales', head.title);
  ok('the header offers New visual, New dashboard and Ask',
     head.visual && head.dashboard && head.ask, JSON.stringify(head));
  ok('the timestamp sits under the title, not out on the right', head.freshUnderTitle);
  ok('"Explain this dataset" and "Prepare data" are gone from the toolbar',
     !head.explain && !head.prepare);
  ok('"Columns" is now "Show/hide columns"', head.colsLabel === 'Show/hide columns', head.colsLabel);

  // ── New visual lands in the builder with THIS dataset chosen ───────────────
  //
  // The point of the button is the preselection, so that is what is asserted —
  // not merely that the builder opened. The modal's step 1 is skipped because
  // the dataset is already known, so step 2 is what appears.
  await win.evaluate(() => (document.getElementById('ds-act-visual') as HTMLElement | null)?.click());
  await win.waitForTimeout(1500);
  const atStep2 = await win.evaluate(() => {
    const overlay = [...document.querySelectorAll('.vn-overlay, .ws-modal-overlay')]
      .find((o) => (o as HTMLElement).getClientRects().length > 0) as HTMLElement | undefined;
    const step2 = overlay?.querySelector('.js-vn-step2') as HTMLElement | null;
    const step1 = overlay?.querySelector('.js-vn-step1') as HTMLElement | null;
    return { open: !!overlay, onStep2: !!step2 && !step2.hidden, onStep1: !!step1 && !step1.hidden };
  });
  ok('New visual opens the picker past the "which dataset" step',
     atStep2.open && atStep2.onStep2 && !atStep2.onStep1, JSON.stringify(atStep2));

  // Build it myself → the builder, with Sales selected in its dataset control.
  await win.evaluate(() => {
    const overlay = [...document.querySelectorAll('.vn-overlay, .ws-modal-overlay')]
      .find((o) => (o as HTMLElement).getClientRects().length > 0) as HTMLElement | undefined;
    (overlay?.querySelector('.js-vn-manual') as HTMLElement | null)?.click();
  });
  await win.waitForTimeout(2500);
  const builder = await win.evaluate(() => {
    const sel = document.querySelector('#viz-builder select, #viz-builder .cd-root') as HTMLElement | null;
    const text = (sel as HTMLSelectElement)?.selectedOptions?.[0]?.textContent
      ?? (sel?.querySelector('.cd-value')?.textContent || '');
    const area = document.getElementById('viz-builder') as HTMLElement | null;
    return { open: !!area && !area.hidden, dataset: (text || '').trim() };
  });
  ok('the builder opens on the dataset the button was pressed from',
     builder.open && /Sales/.test(builder.dataset), JSON.stringify(builder));

  // Back to the dataset for the rest of the file.
  await clickExact('Data');
  await win.waitForTimeout(1000);
  await win.evaluate(() => {
    const el = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')]
      .find((x) => /Sales/.test(x.textContent || '')) as HTMLElement | undefined;
    el?.click();
  });
  await win.waitForTimeout(2500);

  // ── The column profile: a TEXT column ──────────────────────────────────────
  //
  // Clicking the NAME must profile without sorting — the two were one button,
  // and a profile that silently reordered the grid under you would be worse
  // than no profile. So the sort state is read before and after.
  const clickedRegion = await win.evaluate(() => {
    const th = [...document.querySelectorAll('#ds-explorer-scroll .ds-th')]
      .find((t) => (t.querySelector('.ds-th-name')?.textContent || '') === 'region');
    const name = th?.querySelector('.ds-th-name') as HTMLElement | undefined;
    if (!name) return false;
    name.click();
    return true;
  });
  ok('the "region" header name is clickable', clickedRegion);
  await win.waitForTimeout(3000);

  const textProfile = await win.evaluate(() => {
    const panel = document.getElementById('ds-profile') as HTMLElement | null;
    const facts: Record<string, string> = {};
    panel?.querySelectorAll('.js-dsp-facts dt').forEach((dt) => {
      const dd = dt.nextElementSibling;
      facts[(dt.textContent || '').trim()] = (dd?.textContent || '').trim();
    });
    const bars = [...(panel?.querySelectorAll('.dsp-bar-row') || [])].map((b) => ({
      label: (b.querySelector('.dsp-bar-label')?.textContent || '').trim(),
      n: (b.querySelector('.dsp-bar-n')?.textContent || '').trim(),
    }));
    return {
      open: !!panel && !panel.hidden,
      name: (panel?.querySelector('.js-dsp-name')?.textContent || '').trim(),
      kind: (panel?.querySelector('.js-dsp-kind')?.textContent || '').trim(),
      heading: (panel?.querySelector('.dsp-head')?.textContent || '').trim(),
      facts,
      bars,
      // The header the panel describes is marked, so it is obvious which column
      // you are reading about when the panel scrolls out of line with the grid.
      marked: !!document.querySelector('#ds-explorer-scroll .ds-th.is-profiled'),
      // Profiling must not have sorted: no header carries a live arrow.
      sorted: [...document.querySelectorAll('#ds-explorer-scroll .ds-th-arrow')]
        .some((a) => !a.classList.contains('is-idle')),
    };
  });
  ok('the profile panel opens on region', textProfile.open && textProfile.name === 'region',
     JSON.stringify({ open: textProfile.open, name: textProfile.name }));
  ok('it names the column type', textProfile.kind === 'text', textProfile.kind);
  ok('it marks the header it is describing', textProfile.marked);
  ok('profiling a column does NOT sort the grid', !textProfile.sorted);
  ok(`region has ${REGIONS} distinct values`,
     textProfile.facts.Distinct === String(REGIONS), JSON.stringify(textProfile.facts));
  ok('region is 100% filled', /^5,?000 of 5,?000 \(100%\)$/.test(textProfile.facts.Filled || ''),
     textProfile.facts.Filled);
  ok('region reports 0 empty', textProfile.facts.Empty === '0', textProfile.facts.Empty);
  ok('a text column charts its top values', textProfile.heading === 'Top values', textProfile.heading);
  ok(`the top value is ${TOP_REGION} with ${TOP_REGION_ROWS} rows`,
     textProfile.bars.length === REGIONS
       && textProfile.bars[0].label === TOP_REGION
       && textProfile.bars[0].n === TOP_REGION_ROWS.toLocaleString(),
     JSON.stringify(textProfile.bars.slice(0, 3)));
  // Ordered by COUNT — "top values" that were not the biggest would be a chart
  // of the wrong thing, and first-seen order is what `visual:data` returns.
  ok('the bars are ordered biggest first',
     textProfile.bars.every((b, i, a) => i === 0
       || Number(a[i - 1].n.replace(/[^\d]/g, '')) >= Number(b.n.replace(/[^\d]/g, ''))),
     JSON.stringify(textProfile.bars.map((b) => b.n)));

  // ── The column profile: a NUMBER column ────────────────────────────────────
  //
  // `amount` is (i % 97) - 10, so it runs -10..86 — the min and max are the
  // fixture's own definition, and the median is the one figure on this panel
  // that no other shipped call can produce (src/ipc/datasets.ts dataset:median).
  await win.evaluate(() => {
    const th = [...document.querySelectorAll('#ds-explorer-scroll .ds-th')]
      .find((t) => (t.querySelector('.ds-th-name')?.textContent || '') === 'amount');
    (th?.querySelector('.ds-th-name') as HTMLElement | undefined)?.click();
  });
  await win.waitForTimeout(3000);

  const numProfile = await win.evaluate(() => {
    const panel = document.getElementById('ds-profile') as HTMLElement | null;
    const facts: Record<string, string> = {};
    panel?.querySelectorAll('.js-dsp-facts dt').forEach((dt) => {
      facts[(dt.textContent || '').trim()] = (dt.nextElementSibling?.textContent || '').trim();
    });
    return {
      name: (panel?.querySelector('.js-dsp-name')?.textContent || '').trim(),
      kind: (panel?.querySelector('.js-dsp-kind')?.textContent || '').trim(),
      heading: (panel?.querySelector('.dsp-head')?.textContent || '').trim(),
      bars: (panel?.querySelectorAll('.dsp-bar-row') || []).length,
      facts,
    };
  });
  ok('the panel re-points at amount', numProfile.name === 'amount' && numProfile.kind === 'number',
     JSON.stringify(numProfile));
  ok('amount runs -10 to 86 (the fixture is (i % 97) - 10)',
     numProfile.facts.Min === '-10' && numProfile.facts.Max === '86', JSON.stringify(numProfile.facts));
  // The median must be a REAL number in range — not "—" (every source failed
  // silently) and not "…" (the reply never landed), which are the two ways this
  // panel breaks while still looking rendered.
  const med = Number(numProfile.facts.Median);
  ok('amount has a computed median inside its own range',
     Number.isFinite(med) && med >= -10 && med <= 86, `Median="${numProfile.facts.Median}"`);
  ok('a number column charts a distribution', numProfile.heading === 'Distribution', numProfile.heading);
  ok('the distribution has bars', numProfile.bars > 0, String(numProfile.bars));

  await win.screenshot({ path: `${shotDir}/dataset-profile-number.png` });

  // Clicking the same name again closes it — the header is a toggle.
  await win.evaluate(() => {
    const th = [...document.querySelectorAll('#ds-explorer-scroll .ds-th')]
      .find((t) => (t.querySelector('.ds-th-name')?.textContent || '') === 'amount');
    (th?.querySelector('.ds-th-name') as HTMLElement | undefined)?.click();
  });
  await win.waitForTimeout(600);
  ok('clicking the same column name closes the panel',
     await win.evaluate(() => !!(document.getElementById('ds-profile') as HTMLElement | null)?.hidden));

  // ── The Quality tab is no longer one sentence on a blank page ──────────────
  await win.evaluate(() => (document.getElementById('ds-tab-quality') as HTMLElement | null)?.click());
  await win.waitForTimeout(1200);

  const quality = await win.evaluate(() => {
    const panel = document.getElementById('ds-tabp-quality') as HTMLElement | null;
    const table = document.getElementById('ds-quality-table') as HTMLElement | null;
    const rows = [...(table?.querySelectorAll('tbody tr') || [])].map((tr) => ({
      name: (tr.children[0]?.textContent || '').trim(),
      type: (tr.children[1]?.textContent || '').trim(),
      filled: (tr.children[2]?.textContent || '').trim(),
      distinct: (tr.children[3]?.textContent || '').trim(),
      sample: (tr.children[4]?.textContent || '').trim(),
    }));
    const none = document.querySelector('.ds-quality-none') as HTMLElement | null;
    return {
      shown: !!panel && !panel.hidden,
      noneVisible: !!none && none.getClientRects().length > 0,
      tableShown: !!table && !table.hidden,
      headers: [...(table?.querySelectorAll('thead th') || [])].map((th) => (th.textContent || '').trim()),
      rows,
    };
  });
  ok('the Quality tab opens', quality.shown);
  ok('a clean dataset still says so', quality.noneVisible);
  ok('and shows a completeness table under it', quality.tableShown);
  ok('the table is headed Column/Type/Filled/Distinct/Sample values',
     quality.headers.join('|') === 'Column|Type|Filled|Distinct|Sample values', quality.headers.join('|'));
  ok(`the table has one row per column (${COLUMNS.length})`,
     quality.rows.length === COLUMNS.length, JSON.stringify(quality.rows.map((x) => x.name)));
  ok('the rows name the fixture\'s columns, in order',
     quality.rows.map((x) => x.name).join(',') === COLUMNS.join(','),
     quality.rows.map((x) => x.name).join(','));
  ok('amount is typed number in the table',
     (quality.rows.find((x) => x.name === 'amount') || {}).type === 'number');
  // `note` is '' on every third row — the one column whose fill bar is not
  // 100%, and the assertion that proves the bar reads real data.
  ok(`note is ${NOTE_FILLED_PCT}% filled (the fixture empties every third row)`,
     (quality.rows.find((x) => x.name === 'note') || {}).filled === `${NOTE_FILLED_PCT}%`,
     (quality.rows.find((x) => x.name === 'note') || {}).filled);
  ok('region is 100% filled in the table',
     (quality.rows.find((x) => x.name === 'region') || {}).filled === '100%');
  ok('every row carries sample values',
     quality.rows.every((x) => x.sample && x.sample !== '—'),
     JSON.stringify(quality.rows.map((x) => x.sample)));

  await win.screenshot({ path: `${shotDir}/dataset-quality.png` });

  // ── The profile panel's scoped actions ─────────────────────────────────────
  //
  // "Filter rows on this" drives the grid's OWN search box rather than a second
  // filtering mechanism beside it, so the assertion is that the search input and
  // the rendered row count both moved.
  await win.evaluate(() => (document.getElementById('ds-tab-data') as HTMLElement | null)?.click());
  await win.waitForTimeout(600);
  await win.evaluate(() => {
    const th = [...document.querySelectorAll('#ds-explorer-scroll .ds-th')]
      .find((t) => (t.querySelector('.ds-th-name')?.textContent || '') === 'region');
    (th?.querySelector('.ds-th-name') as HTMLElement | undefined)?.click();
  });
  await win.waitForTimeout(2500);
  await win.evaluate(() => {
    (document.querySelector('#ds-profile .js-dsp-filter-btn') as HTMLElement | null)?.click();
  });
  await win.waitForTimeout(2500);
  const filtered = await win.evaluate(() => ({
    search: (document.getElementById('ds-search') as HTMLInputElement | null)?.value || '',
    note: (document.getElementById('ds-explorer-note')?.textContent || '').trim(),
  }));
  ok('"Filter rows on this" fills the grid\'s own search box with the modal value',
     filtered.search === TOP_REGION, filtered.search);
  ok('and the grid reports the narrowed row count',
     /715/.test(filtered.note) && !/5,?000 rows/.test(filtered.note), filtered.note);

  await win.screenshot({ path: `${shotDir}/dataset-profile-text.png` });

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await smoke.close();
}

main()
  .then(() => finishSmoke('dataset', failureCount()))
  .catch((err) => {
    console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  });
