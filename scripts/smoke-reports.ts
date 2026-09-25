// REPORTS, end to end, in the real app — and measured on the FILES.
//
// The bug this file exists to catch is the one a DOM assertion cannot see: a
// report that looks right in the builder and lands on disk as a deck with one
// slide, or a Word document whose figures are a picture, or a caption the
// author edited that the writer quietly dropped. So the builder is driven
// through its real controls, and then everything after Generate is asserted by
// opening the produced file:
//
//   • the PPTX is UNZIPPED and its `ppt/slides/slide*.xml` counted, then its
//     slide text read for the edited caption and for "5.2M";
//   • the DOCX is unzipped and `word/document.xml` read for the same two;
//   • the PDF is asserted non-trivial (pdfmake's own text is compressed, so a
//     byte scan would prove nothing — the size is the honest check here).
//
// "5.2M" is not a magic number: the bundled sample's revenue column sums to
// 5,194,598.7, which the app's compact format prints as 5.2M. If that file
// changes, this assertion should fail — a report printing a figure the dataset
// does not contain is exactly what it is here to notice.
//
// The ZIP reader below is 40 lines of zlib rather than a dependency or a shell
// call to `unzip`: this repo does not add a runtime or dev dependency to read
// two files, and a CI image without `unzip` would be a silent skip.
//
//   npm run build:ts && node scripts/smoke-reports.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const zlib: typeof import('zlib') = require('zlib');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-reports-'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-reports-out-'));
const schedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-reports-sched-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

// ── a minimal ZIP reader (central directory → one inflated entry) ────────────

/** Every stored path in a .zip, with its local-header offset. */
function zipEntries(buf: Buffer): Map<string, number> {
  const out = new Map<string, number>();
  // End of Central Directory: scan back from the tail for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.set(buf.toString('utf8', p + 46, p + 46 + nameLen), buf.readUInt32LE(p + 42));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** One entry's bytes as text. Stored (method 0) and deflated (method 8) only —
 *  the two JSZip, pptxgenjs and docx actually emit. */
function zipRead(buf: Buffer, offset: number): string {
  if (buf.readUInt32LE(offset) !== 0x04034b50) return '';
  const method = buf.readUInt16LE(offset + 8);
  const csize = buf.readUInt32LE(offset + 18);
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + csize);
  if (method === 0) return raw.toString('utf8');
  if (method === 8) return zlib.inflateRawSync(raw).toString('utf8');
  return '';
}

/** All the text inside an OOXML part, tags stripped. */
function xmlText(xml: string): string {
  return xml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function waitForFile(p: string, timeoutMs: number): Promise<number> {
  const until = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < until) {
    if (fs.existsSync(p)) {
      const size = fs.statSync(p).size;
      if (size > 0 && size === last) return size; // two equal reads = settled
      last = size;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO, timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // The first paint is a SPLASH — an assertion there proves nothing.
  await win.waitForTimeout(4500);
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => { /* already gone */ });

  // ── Stub the save panel and count notifications, in MAIN ──────────────────
  //
  // Playwright cannot drive a native save panel, so showSaveDialog is replaced
  // with one that answers a path in this run's own tmp dir.
  //
  // Notifications are counted at the notify.ts SEAM rather than by swapping
  // electron's Notification class: electron defines its own exports as lazy
  // getters, so assigning over one silently does nothing. And whether the OS
  // then renders a banner is not this app's contract in the first place — an
  // unsigned macOS build shows none, and headless Linux may report none
  // supported. What IS the contract is that a scheduled write calls notifyFile
  // exactly once, naming the file it just wrote, and that is what is asserted.
  await app.evaluate(async (electron: any, dirs: any) => {
    (global as any).__savePaths = [];
    (global as any).__notifications = [];
    electron.dialog.showSaveDialog = async (opts: any) => {
      const base = String((opts && opts.defaultPath) || 'report').split(/[\\/]/).pop();
      const p = dirs.out + '/' + base;
      (global as any).__savePaths.push(p);
      return { canceled: false, filePath: p };
    };
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const notify = req('./src/app/notify.js');
    notify.notifyFile = (body: string, filePath: string) => {
      (global as any).__notifications.push(body + ' :: ' + filePath);
      return true;
    };
  }, { out: outDir });

  // ── The bundled sample's project + dashboard ──────────────────────────────
  const seeded: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const analysis = req('./src/analysis/analysis.js');
    const list = await projects.listProjects();
    for (const p of list) {
      const analyses = await analysis.listAnalyses(p.id);
      if (analyses.length) return { projectId: p.id, analysisId: analyses[0].id, name: analyses[0].name };
    }
    return null;
  });
  ok('the bundled sample seeded a project with a dashboard', !!(seeded && seeded.analysisId), JSON.stringify(seeded));
  if (!seeded) { await app.close(); return; }

  // ── Open it, then Create report… ──────────────────────────────────────────
  await win.evaluate(async (s: any) => {
    await (window as any).openWorkspace(s.projectId);
    (window as any).selectSection('analyses');
    await (window as any).openAnalysis(s.analysisId);
  }, seeded);
  await win.waitForTimeout(2500);

  ok('the dashboard ⋯ menu has a "Create report…" entry to delegate to',
    await win.evaluate(() => !!document.getElementById('dash-report-btn')));

  await win.evaluate(() => { (document.getElementById('dash-report-btn') as HTMLElement).click(); });
  await win.waitForTimeout(6000);

  const builder: any = await win.evaluate(() => ({
    visible: !(document.getElementById('rp-builder') as HTMLElement).hidden,
    kinds: [...document.querySelectorAll('#rp-page-list .rb-page-kind')].map((e) => (e.textContent || '').trim()),
    sheetVisible: !!document.querySelector('.rb-sheet'),
  }));
  ok('the builder opened', builder.visible);
  ok('its page list is cover, summary, one sheet page and three tile pages',
    builder.kinds.join(',') === 'Cover,Summary,Sheet,Tile,Tile,Tile', builder.kinds.join(','));
  ok('the preview drew a page at page size', builder.sheetVisible);
  await win.screenshot({ path: path.join(shotDir, 'reports-builder.png') });

  // ── Edit one caption, on a Tile page ──────────────────────────────────────
  const EDITED = 'Technology carried the quarter.';
  const captionState: any = await win.evaluate(async (edited: string) => {
    const kinds = [...document.querySelectorAll('#rp-page-list .rb-page-kind')];
    const tileIdx = kinds.findIndex((e) => (e.textContent || '').trim() === 'Tile');
    (document.querySelectorAll('#rp-page-list .rb-page-btn')[tileIdx] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 6000));
    const box = document.getElementById('rp-caption') as HTMLTextAreaElement;
    const before = box ? box.value : '';
    const rowHidden = (document.getElementById('rp-caption-row') as HTMLElement).hidden;
    box.value = edited;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      before, rowHidden,
      resetShown: !(document.getElementById('rp-caption-reset') as HTMLElement).hidden,
      stored: (window as any).__rbPageCaption ? '' : '',
    };
  }, EDITED);
  ok('the caption editor is offered on a tile page', captionState.rowHidden === false);
  ok('it is pre-filled with the APP\'s own sentence, not an empty box',
    typeof captionState.before === 'string' && captionState.before.length > 8, captionState.before);
  ok('"Reset to app caption" appears once the author overrides it', captionState.resetShown === true);
  await win.waitForTimeout(1200);
  await win.screenshot({ path: path.join(shotDir, 'reports-tile-page.png') });

  // ── Generate all three formats ────────────────────────────────────────────
  const files: Record<string, string> = {};
  for (const format of ['pdf', 'pptx', 'docx']) {
    await win.evaluate(async (f: string) => {
      const sel = document.getElementById('rp-set-format') as HTMLSelectElement;
      sel.value = f;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 4000));
      (document.getElementById('rp-generate') as HTMLElement).click();
    }, format);
    // The 16:9 preview IS the slide's layout — same RenderedPage, same blocks —
    // so this is the closest a headless run can get to a picture of a slide.
    if (format === 'pptx') await win.screenshot({ path: path.join(shotDir, 'reports-pptx-slide-preview.png') });
    const saved: string[] = await app.evaluate(() => (global as any).__savePaths);
    // The panel is stubbed, so the destination is known before the write lands.
    const want = saved.length ? saved[saved.length - 1] : '';
    let dest = want;
    if (!dest) {
      // First pass for this format: wait for the stub to be called at all.
      for (let i = 0; i < 40 && !dest; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s2: string[] = await app.evaluate(() => (global as any).__savePaths);
        dest = s2.length ? s2[s2.length - 1] : '';
      }
    }
    // The click happens before the save panel is reached, so poll for the path
    // belonging to THIS format rather than trusting the previous one.
    let sized = 0;
    for (let i = 0; i < 60; i++) {
      const s2: string[] = await app.evaluate(() => (global as any).__savePaths);
      const match = s2.filter((p) => p.endsWith('.' + format)).pop();
      if (match) {
        sized = await waitForFile(match, 30_000);
        if (sized > 0) { files[format] = match; break; }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    ok(`Generate produced a .${format} on disk`, sized > 0, files[format] + ' ' + sized);
  }

  // ── Read the produced files ───────────────────────────────────────────────
  if (files.pdf) {
    // pdfmake compresses its content streams, so a byte scan for "5.2M" would
    // prove nothing either way. A six-page report is several tens of KB; a
    // failed build that still wrote a file would be a stub of a few hundred.
    ok('the PDF is a real document, not a stub', fs.statSync(files.pdf).size > 20_000,
      fs.statSync(files.pdf).size);
  }
  if (files.pptx) {
    const buf = fs.readFileSync(files.pptx);
    const entries = zipEntries(buf);
    const slides = [...entries.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
    ok('the PPTX has one slide per included page (6)', slides.length === 6, slides.length);
    const text = slides.map((k) => xmlText(zipRead(buf, entries.get(k) as number))).join(' ');
    ok('a slide carries the edited caption', text.includes(EDITED), text.slice(0, 400));
    ok('a slide carries the app-computed 5.2M', text.includes('5.2M'), text.slice(0, 400));
    ok('the KPI row is a NATIVE table, not a picture of numbers',
      [...entries.keys()].some((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      && slides.some((k) => zipRead(buf, entries.get(k) as number).includes('<a:tbl>')));
  }
  if (files.docx) {
    const buf = fs.readFileSync(files.docx);
    const entries = zipEntries(buf);
    const doc = entries.has('word/document.xml') ? zipRead(buf, entries.get('word/document.xml') as number) : '';
    const text = xmlText(doc);
    ok('the DOCX carries the edited caption', text.includes(EDITED), text.slice(0, 400));
    ok('the DOCX carries the app-computed 5.2M', text.includes('5.2M'), text.slice(0, 400));
    ok('the DOCX breaks pages with Word\'s own page break', doc.includes('pageBreakBefore'));
  }

  // ── A daily schedule, on a faked clock ────────────────────────────────────
  //
  // The folder is set on the record directly rather than through the picker:
  // Playwright cannot drive a native folder panel either, and the picker's only
  // job is to produce this string.
  // Read the id from MAIN rather than the renderer: `rbReport` is a top-level
  // `let` in a classic script, which — unlike `var` — never lands on `window`.
  const reportId: string = await app.evaluate(async (_electron, projectId: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const spec = req('./src/analysis/reportSpec.js');
    const list = await spec.listReports(projectId);
    return list.length ? list[0].id : '';
  }, seeded.projectId);
  ok('the created report is on disk, one of them', !!reportId, reportId);
  await app.evaluate(async (_electron, args: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const spec = req('./src/analysis/reportSpec.js');
    await spec.updateReport(args.projectId, args.id, {
      schedule: { cadence: 'daily', at: '09:00', folder: args.folder },
    });
  }, { projectId: seeded.projectId, id: reportId, folder: schedDir });

  const before: string[] = await app.evaluate(() => (global as any).__notifications);
  // 14:30 on a fixed day: past the 09:00 gate, and a date this run can predict.
  const fakeNow = new Date(2031, 4, 7, 14, 30).getTime();
  const written: number = await win.evaluate((n: number) => (window as any).reportsRunDue(n), fakeNow);
  ok('reportsRunDue generated exactly the one due report', written === 1, written);

  const stamped = fs.readdirSync(schedDir);
  ok('it landed in the scheduled folder under a DATED name',
    stamped.some((f) => /-2031-05-07\.(pdf|pptx|docx)$/.test(f)), stamped.join(','));
  ok('the dated file has real bytes',
    stamped.length === 1 && fs.statSync(path.join(schedDir, stamped[0])).size > 5_000,
    stamped.map((f) => f + ':' + fs.statSync(path.join(schedDir, f)).size).join(','));

  const after: string[] = await app.evaluate(() => (global as any).__notifications);
  ok('it raised exactly one notification', after.length - before.length === 1,
    JSON.stringify(after.slice(before.length)));
  ok('the notification names the file it wrote',
    (after[after.length - 1] || '').includes('2031-05-07'), after[after.length - 1]);

  const stored: any = await app.evaluate(async (_electron, args: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const spec = req('./src/analysis/reportSpec.js');
    const r = await spec.getReport(args.projectId, args.id);
    return { lastRunAt: r && r.lastRunAt, lastFile: r && r.lastFile };
  }, { projectId: seeded.projectId, id: reportId });
  ok('the run stamped the record with the FAKED clock, not the wall clock',
    String(stored.lastRunAt).startsWith('2031-05-07'), stored.lastRunAt);
  ok('and remembered the file it produced', String(stored.lastFile).startsWith(schedDir));

  // ── Back out to the Reports tab ───────────────────────────────────────────
  const tab: any = await win.evaluate(async () => {
    (document.getElementById('rp-back') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 600));
    (document.getElementById('rp-tab-reports') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 1500));
    const cards = [...document.querySelectorAll('#rp-grid .rb-card')];
    return {
      builderHidden: (document.getElementById('rp-builder') as HTMLElement).hidden,
      count: cards.length,
      badge: cards[0] ? (cards[0].querySelector('.rb-card-badge') as HTMLElement).textContent : '',
      lines: cards[0] ? [...cards[0].querySelectorAll('.rb-card-line')].map((e) => (e.textContent || '').trim()) : [],
      actions: cards[0] ? [...cards[0].querySelectorAll('.rb-card-actions button')].map((e) => (e.textContent || '').trim()) : [],
      dashHidden: (document.getElementById('an-table') as HTMLElement).hidden,
    };
  });
  ok('Back returns to the list', tab.builderHidden === true);
  ok('the Reports tab lists the report', tab.count === 1, tab.count);
  ok('its card carries the format badge', tab.badge === 'DOCX', tab.badge);
  ok('its card says the schedule and when it last ran',
    tab.lines.some((l: string) => l.startsWith('Every day at 09:00'))
    && tab.lines.some((l: string) => l.startsWith('Last generated')), JSON.stringify(tab.lines));
  ok('its card offers its actions, History and Lineage among them',
    tab.actions.join(',') === 'Generate now,Edit,History,Lineage,Duplicate,Delete', tab.actions.join(','));
  ok('switching to Reports hides the dashboards grid', tab.dashHidden === true);
  await win.screenshot({ path: path.join(shotDir, 'reports-tab.png') });

  // Home's Recent should now carry the generated report.
  const recent: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const recentMod = req('./src/app/recent.js');
    const items = await recentMod.listRecent(50);
    return items.filter((i: any) => i.type === 'report').map((i: any) => i.name);
  });
  ok('Home\'s Recent includes the generated report', recent.length === 1, JSON.stringify(recent));

  // ── Zero renderer console errors, over the whole run ──────────────────────
  ok('no renderer console errors', errors.length === 0, errors.slice(0, 5).join(' | '));

  await app.close();
}

main()
  .catch((e) => { console.error('FAIL harness threw', e); process.exitCode = 1; })
  .finally(() => {
    for (const d of [userData, outDir, schedDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    }
    // `process.exitCode` is already 1 if the harness itself threw — a run that
    // fell over before it could assert must never print a pass.
    const bad = failureCount() > 0 || process.exitCode === 1;
    if (!bad) console.log('\nAll report smoke checks passed.');
    process.exit(bad ? 1 : 0);
  });
