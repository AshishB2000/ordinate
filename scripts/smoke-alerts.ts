// Alerts, in the REAL app: write a rule from the number on screen, make it fire,
// and read it back off disk after a reload.
//
// scripts/test-alerts.ts pins the DECISION — edge-triggering, quiet hours, the
// sentence, the differential against the dashboard's own metric. What only a
// running app can show is whether the surfaces are actually joined to it:
//
//   the Revenue KPI's menu writes a rule about THAT card's number · Test runs
//   the real metric path and answers with the real figure · the card grows a
//   bell · evaluating fires it, once · the OS is told · the inbox counts it ·
//   Mark seen clears the count · a change rule stays QUIET on an unchanged
//   refresh · the rules page lists both · and all of it survives a reload.
//
// THE FIGURE IS THE POINT. The bundled sample's revenue sums to 5,194,598.73,
// which every metric path in this app renders as "5.2M". A rule written as
// "< 6,000,000" must test, fire and NOTIFY with that exact string — an alert
// that says a different number from the card it is about is the failure this
// whole feature would not survive.
//
// A fresh userData, so the bundled sample project ("Retail orders" / "Retail
// overview") is there to alert on — the same first-launch state smoke-sample.ts
// asserts.
//
//   npm run smoke   (or: node scripts/smoke-alerts.js)

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-alerts-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

/** What the sample's revenue actually sums to, and how the app renders it. */
const REVENUE_SHOWN = '5.2M';

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO,
    timeout: 120_000,
  });
  let win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');

  const errors: string[] = [];
  const watchConsole = (w: any): void => {
    w.on('pageerror', (e: any) => errors.push('pageerror: ' + e.message));
    w.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  };
  watchConsole(win);

  // The first paint is a SPLASH — a screenshot there passes every check while
  // proving nothing. Wait it out, then remove it defensively.
  await win.waitForSelector('#splash', { state: 'hidden', timeout: 60_000 }).catch(() => {});
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  await win.waitForSelector('#side-ai-btn', { timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1440, 900); });
  // The sample is seeded on first launch and the rule is written against it.
  await win.waitForTimeout(4000);

  // ── Stub Notification in MAIN ───────────────────────────────────────────
  //
  // `show` on the PROTOTYPE, not the class on the module: `Notification` is a
  // non-configurable property of the electron module and cannot be replaced.
  // Recording there is better anyway — the object whose title and body are read
  // is the very one `notify.notifyAlert` built.
  //
  // Stubbed rather than observed because NEITHER CI platform can actually emit
  // one, for two different reasons: macOS refuses to notify from an UNSIGNED
  // build (see notify.ts), and headless Linux under xvfb has no notification
  // daemon at all, so `Notification.isSupported()` is false there. That second
  // one is why `isSupported` is stubbed too — `notifyAlert` checks it and
  // returns early, so without this the spy records nothing on Linux while
  // passing on a developer's Mac. What is asserted either way is that the app
  // ASKED, with the right title and the right figure.
  const stub: any = await app.evaluate((electron: any) => {
    const calls: any[] = [];
    electron.app.__alertNotifications = calls;
    // Prove the override actually TAKES before relying on it: set it to the
    // wrong answer, read it back, then set it to the one this run needs. On
    // macOS `isSupported()` is true anyway, so a bare `= () => true` would
    // assert nothing here and still leave Linux recording zero calls — which is
    // exactly the break this line exists to stop coming back.
    electron.Notification.isSupported = () => false;
    const takes = electron.Notification.isSupported() === false;
    electron.Notification.isSupported = () => true;
    electron.Notification.prototype.show = function record(this: any): void {
      calls.push({ title: this.title, body: this.body });
    };
    return { takes, supported: electron.Notification.isSupported() };
  });
  ok('the Notification stub overrides isSupported on this platform',
    stub.takes === true && stub.supported === true, JSON.stringify(stub));
  const notifications = (): Promise<any[]> =>
    app.evaluate((electron: any) => electron.app.__alertNotifications || []);

  // ── Open the sample dashboard ───────────────────────────────────────────
  const seeded: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const analysis = req('./src/analysis/analysis.js');
    const datasets = req('./src/data/datasets.js');
    const p = (await projects.listProjects())[0];
    const list = await analysis.listAnalyses(p.id);
    const ds = await datasets.listDatasets(p.id);
    const a = list[0] ? await analysis.getAnalysis(p.id, list[0].id) : null;
    // The card is identified from the RECORD, not from a renderer global: the
    // hub's `let dashCurrent` is a lexical binding, not a window property, so
    // page.evaluate cannot reach it by name.
    let revenueCardId = '';
    for (const sheet of (a && a.sheets) || []) {
      for (const card of sheet.cards || []) {
        if (card.type === 'metric' && card.metric && card.metric.label === 'Revenue') revenueCardId = card.id;
      }
    }
    return { projectId: p.id, analysisId: list[0] && list[0].id, datasetId: ds[0] && ds[0].id, revenueCardId };
  });
  ok('the bundled sample is on disk to alert on',
    Boolean(seeded.projectId && seeded.analysisId && seeded.datasetId), JSON.stringify(seeded));

  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.evaluate(async (id: string) => { await (window as any).openAnalysis(id); }, seeded.analysisId);
  await win.waitForFunction(() => document.body.classList.contains('an-focus'), { timeout: 20_000 });
  await win.waitForTimeout(2000);

  const revenueCardId: string = seeded.revenueCardId;
  ok('the sample dashboard has a Revenue KPI card', Boolean(revenueCardId), revenueCardId);
  await win.waitForSelector(`.dash-card[data-card-id="${revenueCardId}"]`, { timeout: 20_000 });
  // The card computes its number over IPC after it paints, so wait for a real
  // figure rather than the "…" placeholder.
  await win.waitForFunction((id: string) => {
    const el = document.querySelector(`.dash-card[data-card-id="${id}"] .dash-metric-value`);
    return Boolean(el && el.textContent && el.textContent !== '…');
  }, revenueCardId, { timeout: 30_000 });

  const shownValue = await win.evaluate((id: string) => {
    const el = document.querySelector(`.dash-card[data-card-id="${id}"] .dash-metric-value`);
    return (el && el.textContent) || '';
  }, revenueCardId);
  ok(`the card itself reads ${REVENUE_SHOWN} — the figure every assertion below is about`,
    shownValue === REVENUE_SHOWN, shownValue);

  // ── The card's menu writes a rule about THAT number ──────────────────────
  await win.evaluate((id: string) => {
    const btn = document.querySelector(`.dash-card[data-card-id="${id}"] .dash-card-menu-btn`) as HTMLElement;
    btn.click();
  }, revenueCardId);
  await win.waitForSelector('.dash-card-menu', { timeout: 8000 });
  const menuItems = await win.locator('.dash-card-menu .chart-menu-item').allTextContents();
  ok('a metric card\'s menu offers "Alert me…", first', menuItems[0] === 'Alert me…', JSON.stringify(menuItems));

  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.dash-card-menu .chart-menu-item')] as HTMLElement[];
    const hit = rows.find((r) => (r.textContent || '').indexOf('Alert me') === 0);
    if (hit) hit.click();
  });
  await win.waitForSelector('#al-dialog', { timeout: 10_000 });
  // The dialog's first job: prove it is about the number on screen.
  await win.waitForFunction(() => {
    const el = document.querySelector('#al-dialog .al-summary-value');
    return Boolean(el && el.textContent && el.textContent !== '…');
  }, { timeout: 15_000 });
  const dialogValue = await win.locator('#al-dialog .al-summary-value').textContent();
  ok('…and the dialog opens showing the card\'s own value, app-computed',
    dialogValue === REVENUE_SHOWN, String(dialogValue));
  ok('…with Threshold as the first of three tabs',
    (await win.locator('#al-dialog .fd-tab').allTextContents()).join(',') === 'Threshold,Change,Anomaly');
  // The modal fades in (panelIn, hub.css). Let it land, or the PR screenshot
  // catches a half-transparent dialog over the dashboard.
  await win.waitForTimeout(600);
  await win.screenshot({ path: path.join(shotDir, 'alerts-dialog.png') });

  // Threshold: < 6,000,000. Typed into the real input, so the dialog's own
  // draft() is what reaches main.
  await win.locator('#al-dialog .al-num').fill('6000000');
  await win.waitForTimeout(300);
  const autoName = await win.locator('#al-dialog .al-name').inputValue();
  ok('the name auto-fills from the condition', autoName === 'Revenue below 6.0M', autoName);

  await win.locator('#al-dialog .al-test-btn').click();
  await win.waitForFunction(() => {
    const el = document.querySelector('#al-dialog .al-test');
    return Boolean(el && !(el as HTMLElement).hidden && (el.textContent || '').indexOf('Checking') < 0);
  }, { timeout: 20_000 });
  const testText = (await win.locator('#al-dialog .al-test').textContent()) || '';
  ok('Test answers "Would fire" — the real metric path, run now',
    /^Would fire/.test(testText), testText);
  ok(`…and reports ${REVENUE_SHOWN}, the same figure the card shows`,
    testText.indexOf(REVENUE_SHOWN) >= 0, testText);

  await win.locator('#al-dialog .al-save').click();
  await win.waitForSelector('#al-dialog', { state: 'detached', timeout: 15_000 });

  // ── The card grows a bell ───────────────────────────────────────────────
  await win.waitForTimeout(1200);
  ok('the watched card now wears a bell',
    (await win.locator(`.dash-card[data-card-id="${revenueCardId}"] .al-card-bell`).count()) === 1);
  ok('…and no OTHER card does — an unwatched card looks exactly as it did',
    (await win.locator('.dash-card .al-card-bell').count()) === 1);
  ok('…and it is not accented yet: a standing rule is information, not news',
    (await win.locator(`.dash-card[data-card-id="${revenueCardId}"] .al-card-bell.is-fired`).count()) === 0);
  await win.screenshot({ path: path.join(shotDir, 'alerts-card-bell.png') });

  // ── Evaluate: it fires, once, and the OS is told ────────────────────────
  const fired: any = await win.evaluate((pid: string) =>
    (window as any).hub.evaluateAlerts(pid), seeded.projectId);
  ok('evaluating the rule fires it', fired && fired.fired === 1, JSON.stringify(fired));
  ok(`…with a message carrying ${REVENUE_SHOWN}`,
    fired.events[0].message.indexOf(REVENUE_SHOWN) >= 0, fired.events[0].message);
  // "Revenue", the CARD's word for this number — not "revenue", the column it
  // happens to be computed over. The alert is read next to the card.
  ok('…saying what it is, in the card\u2019s own words',
    fired.events[0].message === `Revenue is ${REVENUE_SHOWN} — below 6.0M.`, fired.events[0].message);

  const notes = await notifications();
  ok('the OS was asked, exactly once', notes.length === 1, JSON.stringify(notes));
  ok('…titled with the rule\'s name', notes[0] && notes[0].title === 'Revenue below 6.0M', JSON.stringify(notes[0]));
  ok(`…and its body carries the app's own figure, ${REVENUE_SHOWN}`,
    String(notes[0] && notes[0].body).indexOf(REVENUE_SHOWN) >= 0, JSON.stringify(notes[0]));

  // Edge-triggering, through the real app: a second evaluation over the SAME
  // unchanged number must say nothing.
  const again: any = await win.evaluate((pid: string) =>
    (window as any).hub.evaluateAlerts(pid), seeded.projectId);
  ok('a second evaluation of a standing breach fires nothing', again.fired === 0, JSON.stringify(again));
  ok('…and does not notify again', (await notifications()).length === 1);

  // ── The inbox counts it ─────────────────────────────────────────────────
  await win.waitForTimeout(800);
  const badge = await win.evaluate(() => {
    const el = document.querySelector('#topbar-alerts .al-badge');
    return (el && el.textContent) || '';
  });
  ok('the bell shows one unread', badge === '1', badge);

  await win.locator('#topbar-alerts').click();
  await win.waitForSelector('#al-pop', { timeout: 8000 });
  const popText = (await win.locator('#al-pop').textContent()) || '';
  ok('the inbox lists the event', popText.indexOf('Revenue below 6.0M') >= 0, popText.slice(0, 160));
  ok(`…with the message and its ${REVENUE_SHOWN}`, popText.indexOf(REVENUE_SHOWN) >= 0, popText.slice(0, 160));
  ok('…marked unseen', (await win.locator('#al-pop .al-ev.is-unseen').count()) === 1);
  await win.screenshot({ path: path.join(shotDir, 'alerts-inbox.png') });

  // The card's bell is accented while the newest event is unseen.
  ok('…and the watched card is now accented, because this is news',
    (await win.locator(`.dash-card[data-card-id="${revenueCardId}"] .al-card-bell.is-fired`).count()) === 1);

  // ── Mark seen clears it ─────────────────────────────────────────────────
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#al-pop .al-ev-act')] as HTMLElement[];
    const hit = rows.find((r) => (r.textContent || '').trim() === 'Mark seen');
    if (hit) hit.click();
  });
  await win.waitForTimeout(1200);
  ok('Mark seen clears the count — a badge that never clears is one people stop reading',
    (await win.locator('#topbar-alerts .al-badge').count()) === 0);
  ok('…and the row stops being unseen', (await win.locator('#al-pop .al-ev.is-unseen').count()) === 0);

  // ── A CHANGE rule stays quiet on an unchanged refresh ───────────────────
  //
  // Written through the same `alerts:save` channel the dialog uses. Nothing
  // about the sample moves between evaluations, so a 10%-change rule that fired
  // here would be firing on noise — the failure that makes people switch alerts
  // off entirely.
  const changeSaved: any = await win.evaluate((args: any) => (window as any).hub.saveAlertRule(args.pid, {
    name: 'Revenue moves 10%',
    datasetId: args.dsid,
    metric: { column: 'revenue', aggregation: 'sum' },
    compare: 'change',
    change: { pct: 10, direction: 'either', vs: 'previous_refresh' },
    enabled: true,
  }), { pid: seeded.projectId, dsid: seeded.datasetId });
  ok('a change rule saves', changeSaved && changeSaved.ok !== false, JSON.stringify(changeSaved));

  // First evaluation only RECORDS a baseline (there is no previous value yet).
  await win.evaluate((pid: string) => (window as any).hub.evaluateAlerts(pid), seeded.projectId);
  const unchanged: any = await win.evaluate((pid: string) =>
    (window as any).hub.evaluateAlerts(pid), seeded.projectId);
  ok('a change rule does NOT fire on an unchanged refresh', unchanged.fired === 0, JSON.stringify(unchanged));
  ok('…and the OS was still only asked once, for the threshold',
    (await notifications()).length === 1);

  // ── The rules page lists both ───────────────────────────────────────────
  await win.evaluate(() => {
    const pop = document.querySelector('#al-pop');
    const rows = pop ? [...pop.querySelectorAll('.al-pop-link')] as HTMLElement[] : [];
    const hit = rows.find((r) => (r.textContent || '').trim() === 'Manage rules');
    if (hit) hit.click();
  });
  await win.waitForSelector('#al-rules', { timeout: 10_000 });
  await win.waitForTimeout(800);
  const ruleNames = await win.locator('#al-rules .al-rule-name').allTextContents();
  ok('the rules page lists both rules',
    ruleNames.length === 2
    && ruleNames.indexOf('Revenue below 6.0M') >= 0
    && ruleNames.indexOf('Revenue moves 10%') >= 0, JSON.stringify(ruleNames));
  const ruleTable = (await win.locator('#al-rules .al-rules-table').textContent()) || '';
  ok('…with each one\'s condition in the same words the dialog used',
    ruleTable.indexOf('is below') >= 0 && ruleTable.indexOf('moves by 10%') >= 0, ruleTable.slice(0, 200));
  ok('…and every rule carries a quiet-hours picker', (await win.locator('#al-rules .al-quiet').count()) === 2);
  await win.waitForTimeout(600);
  await win.screenshot({ path: path.join(shotDir, 'alerts-rules.png') });
  await win.keyboard.press('Escape');

  // ── Persisted on disk ───────────────────────────────────────────────────
  const onDisk: any = await app.evaluate(async (electron: any, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const p = req('path').join(electron.app.getPath('userData'), 'projects', pid, 'alerts.json');
    return JSON.parse(req('fs').readFileSync(p, 'utf8'));
  }, seeded.projectId);
  ok('the rules are on disk, in the project\'s own alerts.json',
    Array.isArray(onDisk.rules) && onDisk.rules.length === 2, JSON.stringify((onDisk.rules || []).map((r: any) => r.name)));
  ok('…and so is the event it fired', Array.isArray(onDisk.events) && onDisk.events.length === 1);
  ok('…with the seen flag the user set', onDisk.events[0].seen === true);

  // ── Reload: what survives is what was stored ────────────────────────────
  await win.reload();
  watchConsole(win);
  await win.waitForSelector('#side-ai-btn', { timeout: 60_000 });
  await win.waitForTimeout(4000);
  const afterReload: any = await win.evaluate((pid: string) =>
    (window as any).hub.listAlerts(pid), seeded.projectId);
  ok('after a reload both rules are still there',
    afterReload.rules.length === 2, JSON.stringify(afterReload.rules.map((r: any) => r.name)));
  ok('…and so is the event, still carrying its figure',
    afterReload.events.length === 1 && afterReload.events[0].message.indexOf(REVENUE_SHOWN) >= 0,
    JSON.stringify(afterReload.events));
  ok('…with nothing unread, because it was marked seen before the reload',
    afterReload.unseen === 0, String(afterReload.unseen));
  ok('…and the threshold rule remembers it is still in breach, so it will not repeat itself',
    afterReload.rules.some((r: any) => r.compare === 'threshold' && r.armed === true),
    JSON.stringify(afterReload.rules.map((r: any) => ({ n: r.name, armed: r.armed }))));

  ok('no renderer console errors anywhere in the alerts flow',
    errors.length === 0, errors.slice(0, 3).join(' | '));

  await app.close();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
}

main()
  .then(() => {
    if (failureCount()) {
      console.error('\n' + failureCount() + ' alerts smoke check(s) FAILED');
      process.exit(1);
    }
    console.log('\nAll alerts smoke checks passed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
