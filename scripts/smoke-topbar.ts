// The window chrome: ONE bar, which is also the window's drag region.
//
// The app used to open with two rows stacked at the top — an EMPTY 40px
// `.titlebar` whose only job was to hold vertical space for the OS window
// controls, and the 40px `.hub-topbar` under it with the search and the Agent
// toggle. The empty one is gone and the top bar carries the controls itself.
//
// THE DRAG REGION IS THE DANGEROUS PART. Merging the rows means making a row
// that contains an <input> into a `-webkit-app-region: drag` region. Get the
// `no-drag` opt-outs wrong and the row swallows the pointer: a real user cannot
// click or type into the search, and nothing reports it — no build error, no
// lint error, no console error, and the element is still there, visible, the
// right size, in the right place.
//
// AND A DRIVEN CLICK DOES NOT CATCH IT. Verified by deleting the `no-drag` rule
// and re-running this file: `page.click` and `page.fill` dispatch DOM events,
// which the drag region never sees, so both still passed. Only the computed
// `-webkit-app-region` assertion failed. So THAT is the guard here, and it is
// asserted directly on the elements a user aims at. The click and typing that
// follow it are worth keeping for what they DO cover — an input that is covered,
// disabled, or not wired — but they are not the drag check and must not be read
// as one.
//
// It also makes the drift guard runnable. hubWindow.ts's TITLEBAR_HEIGHT is the
// height of the Windows control overlay and hub.css's `.hub-topbar` is the row
// the overlay has to sit in; a comment saying "the two must match" is a wish. A
// WCO shorter than the row leaves the Windows buttons floating in its top half,
// a taller one overlaps the search — and neither is visible on macOS, where
// this is developed. The constant is exported for exactly this assertion.
//
// Separate file, not more lines in smoke-app.ts or smoke-dock.ts: both are at
// their allowlisted line counts (.claude/rules/file-size.md) and the ratchet
// only tightens.
//
//   npm run smoke   (or: node scripts/smoke-topbar.js)

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { closeApp } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-topbar-'));

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO,
    timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');

  const errors: string[] = [];
  win.on('pageerror', (e: any) => errors.push('pageerror: ' + e.message));
  win.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await win.waitForSelector('#splash', { state: 'hidden', timeout: 60_000 }).catch(() => {});
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  await win.waitForSelector('#side-ai-btn', { timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1440, 900); });
  await win.waitForTimeout(1500);

  // ── ONE row, and the content starts right under it ──────────────────────
  const chrome = await win.evaluate(() => {
    const bar = document.querySelector('.hub-topbar') as HTMLElement;
    const body = document.querySelector('.hub-body') as HTMLElement;
    const b = bar.getBoundingClientRect();
    return {
      titlebars: document.querySelectorAll('.titlebar').length,
      barTop: Math.round(b.top),
      barH: Math.round(b.height),
      bodyTop: Math.round(body.getBoundingClientRect().top),
      drag: getComputedStyle(bar).getPropertyValue('-webkit-app-region').trim(),
    };
  });
  ok('the empty .titlebar strip is gone', chrome.titlebars === 0, JSON.stringify(chrome));
  ok('…one bar, flush against the top of the window', chrome.barTop === 0, JSON.stringify(chrome));
  // The 40px the strip used to take is back in the content, not merely hidden:
  // the body starts at the bar's bottom edge with nothing between them.
  ok('…and the content starts immediately under it, with no second row of chrome',
    chrome.bodyTop === chrome.barH, JSON.stringify(chrome));
  ok('…the bar IS the window drag region', chrome.drag === 'drag', String(chrome.drag));

  // ── The drift guard: main's overlay height IS this row ──────────────────
  const wcoHeight: number = await app.evaluate(() => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/windows/hubWindow.js').TITLEBAR_HEIGHT;
  });
  ok('the Windows control-overlay height matches the rendered bar',
    wcoHeight === chrome.barH, `main=${wcoHeight} css=${chrome.barH}`);

  // ── The search still works inside the drag region ───────────────────────
  // THIS pair is the drag guard — not the click below it. A drag region eats the
  // pointer before the page sees it, which is invisible to a driven click (see
  // the header: with the `no-drag` rule deleted, the click and fill below both
  // still passed and only this assertion failed).
  // `-webkit-app-region` is not in TS's CSSStyleDeclaration — read it through
  // getPropertyValue, which is untyped and is what the DOM actually exposes.
  const optOut = await win.evaluate(() => {
    const region = (el: Element): string =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region').trim();
    return {
      searchWrap: region(document.querySelector('.hub-search-wrap')!),
      toggle: region(document.getElementById('side-ai-btn')!),
    };
  });
  ok('the search and the Agent toggle opt back OUT of drag',
    optOut.searchWrap === 'no-drag' && optOut.toggle === 'no-drag', JSON.stringify(optOut));

  // Not the drag check (see above) — this covers the input being covered by
  // something, disabled, or simply not wired up.
  //
  // What a click into it DOES changed: the box's own results dropdown is gone
  // and the command palette opens on focus instead (palette.ts), so the caret
  // lands in #cp-input rather than staying here. That is the assertion now —
  // an input eaten by the drag region opens nothing at all.
  await win.click('#global-search', { timeout: 8000 });
  await win.waitForSelector('#cp-overlay:not([hidden])', { timeout: 8000 });
  ok('…and clicking the search still reaches the page — it opens the palette',
    await win.evaluate(() => document.activeElement !== null && document.activeElement.id === 'cp-input'),
    await win.evaluate(() => (document.activeElement as HTMLElement).id || (document.activeElement as HTMLElement).tagName));
  await win.fill('#cp-input', 'Retail');
  ok('…which accepts typing', (await win.inputValue('#cp-input')) === 'Retail');

  // The palette is centred on the WINDOW and floats over the bar rather than
  // hanging off it — so what a shorter bar must not do is clip it.
  const drop = await win.evaluate(() => {
    const d = document.querySelector('.cp-box')!.getBoundingClientRect();
    const b = document.querySelector('.hub-topbar')!.getBoundingClientRect();
    return { below: Math.round(d.top - b.bottom), h: Math.round(d.height), w: Math.round(d.width) };
  });
  ok('…and the palette opens BELOW the bar, at its own width, unclipped',
    drop.below > 0 && drop.h > 0 && drop.w === 640, JSON.stringify(drop));
  await win.keyboard.press('Escape');
  await win.waitForSelector('#cp-overlay', { state: 'hidden', timeout: 8000 });
  await win.waitForTimeout(300);

  // ── The search is still centred on the WINDOW ───────────────────────────
  // Equal-flex sides do the centring, and the OS reservations are min-widths on
  // those sides rather than padding on the row — precisely so this survives.
  const centred = await win.evaluate(() => {
    const s = document.querySelector('.hub-search')!.getBoundingClientRect();
    return { search: Math.round(s.left + s.width / 2), window: Math.round(window.innerWidth / 2) };
  });
  ok('the search is centred on the window, not on the space beside the toggle',
    Math.abs(centred.search - centred.window) <= 1, JSON.stringify(centred));

  // ── Focus mode: the bar stays, and the workbench is not clipped ─────────
  // body.an-focus hides the sidebar, so this bar is the only chrome left — and
  // the only place to drag the window from. #ws-analyses is sized against it by
  // hand (calc(100vh - 40px)); when the chrome was 88px and that calc said 40px,
  // the workbench's bottom 48px sat clipped under .win's overflow:hidden.
  await win.evaluate(() => { document.body.classList.add('an-focus'); });
  await win.waitForTimeout(600);
  const focus = await win.evaluate(() => {
    const bar = document.querySelector('.hub-topbar') as HTMLElement;
    const panel = document.getElementById('ws-analyses') as HTMLElement;
    const prev = panel.hidden;
    panel.hidden = false;
    const r = panel.getBoundingClientRect();
    const barVisible = bar.getBoundingClientRect().height > 0;
    panel.hidden = prev;
    return { barVisible, bottom: Math.round(r.bottom), innerHeight: window.innerHeight };
  });
  ok('in focus mode the bar stays — it is the last chrome and the last drag handle',
    focus.barVisible === true, JSON.stringify(focus));
  ok('…and the workbench bottom lands inside the window, not clipped under it',
    focus.bottom <= focus.innerHeight + 1, JSON.stringify(focus));

  // ── …and the analysis flyout takes its height from the ROW, not from a sum ─
  // It carried `max-height: calc(100vh - 78px)` — an unattributable constant
  // sitting beside a documented one — plus a focus-mode override that #133 had
  // to keep re-deriving every time the chrome moved. Both are gone: the flyout
  // is a `stretch`ed flex item of a row that is already bounded, so it fills the
  // row exactly and scrolls inside it. That is what is asserted, in the same
  // synthetic focus state as the check above (a REAL open analysis, with the
  // editor head moved into the strip, is smoke-dock.ts's job — it measures the
  // same element's width there). No expected pixel count is written down: both
  // sides are read off the render.
  //
  // A number here would rot. `maxHeight: 'none'` is the guard that a future
  // chrome change cannot answer by patching an arithmetic constant again.
  const side = await win.evaluate(() => {
    const panel = document.getElementById('ws-analyses') as HTMLElement;
    const host = document.getElementById('an-editor-host') as HTMLElement;
    const el = document.getElementById('an-side-left') as HTMLElement;
    const prevPanel = panel.hidden;
    const prevSide = el.hidden;
    const prevActive = host.classList.contains('is-active');
    panel.hidden = false;
    el.hidden = false;
    host.classList.add('is-active');
    const r = el.getBoundingClientRect();
    const row = host.getBoundingClientRect();
    const out = {
      maxH: getComputedStyle(el).maxHeight,
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      rowTop: Math.round(row.top), rowBottom: Math.round(row.bottom),
      innerHeight: window.innerHeight,
    };
    panel.hidden = prevPanel;
    el.hidden = prevSide;
    if (!prevActive) host.classList.remove('is-active');
    return out;
  });
  ok('the analysis flyout has no 100vh arithmetic cap left on it',
    side.maxH === 'none', JSON.stringify(side));
  ok('…it fills the workbench row exactly, top and bottom',
    side.top === side.rowTop && side.bottom === side.rowBottom, JSON.stringify(side));
  ok('…and the row it fills already ends inside the window',
    side.rowBottom <= side.innerHeight + 1, JSON.stringify(side));

  await win.evaluate(() => { document.body.classList.remove('an-focus'); });

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 5).join(' | '));

  await closeApp(app);
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failureCount()) {
      console.error(`${failureCount()} topbar smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All topbar smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
