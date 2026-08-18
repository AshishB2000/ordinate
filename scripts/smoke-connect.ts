// End-to-end smoke test of the CONNECT SHORTCUTS — launches the REAL app.
//
// WHAT THIS GUARDS. The Connect rail is a deliberate five-source shortlist plus
// a "More…" door to the full 35-source catalog. Its named entries went nowhere
// useful: PostgreSQL and MySQL both opened the same undifferentiated grid that
// More… opens, so clicking "PostgreSQL" made you go and find PostgreSQL — the
// one step a named shortlist exists to save.
//
// WHY THE EXISTING COVERAGE DID NOT CATCH IT. smoke-app.ts already asserts these
// entries render with real source marks, and every one of those assertions
// passes on the broken build. Drawn correctly and landing somewhere sensible are
// INDEPENDENT properties, and only the first has ever been checked. These checks
// click each shortcut and assert WHERE IT LANDS.
//
// The routing is worth a real Electron boot rather than a DOM harness because
// every hop in it is `typeof x === 'function'`-guarded across three files —
// projects.ts's runSourceAction → connections.ts's openConnPanel →
// workspace.ts's selectSection → back to refreshConnPanel. A rename anywhere
// along that chain degrades to "opens the picker" SILENTLY: no build error, no
// lint error, no test failure, just a shortcut that quietly stops being one.
//
// NOT COVERED HERE: the Screenshot entry, which is not a connector at all — it
// opens the full-screen Capture workspace, and smoke-app.ts already asserts that
// (`capture: the left nav is gone entirely`). CSV / Excel starts a file import
// (native picker) and Paste data opens the paste surface — neither is a connector.
//
// Separate script, not more lines in smoke-app.ts, for the reason
// smoke-composer.ts / smoke-explore.ts / smoke-dock.ts already are: smoke-app.ts
// is allowlisted in scripts/test-file-size.ts and that ratchet only tightens.
//
//   npm run smoke

export {}; // module scope — sibling scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-connect-'));

let failures = 0;
function ok(label: string, cond: boolean, extra?: string): void {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else {
    console.error('FAIL ' + label + (extra ? '  ' + extra : ''));
    failures++;
  }
}

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

  // The first paint is a SPLASH — every assertion below would pass against it
  // while proving nothing, so wait for the real chrome.
  await win.waitForSelector('#splash', { state: 'hidden', timeout: 60_000 }).catch(() => {});
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  await win.waitForSelector('#side-ai-btn', { timeout: 60_000 });

  const section = () =>
    win.evaluate(() => (document.querySelector('.hub-body') as HTMLElement | null)?.dataset.section || '');

  // Wait for the Connect section to be ACTIVE, not for a fixed sleep: the rail
  // entries resolve a project first (async), so the panel arrives a beat after
  // the click. An earlier draft of this used a fixed timeout and was flaky, and
  // a flaky assertion is worse than no assertion — it teaches you to re-run
  // rather than to read.
  const waitForConnect = async (): Promise<void> => {
    await win.waitForFunction(
      () => (document.querySelector('.hub-body') as HTMLElement | null)?.dataset.section === 'connect',
      null, { timeout: 30_000 }).catch(() => {});
    // refreshConnPanel awaits the connector catalog before it decides between
    // the picker and a preselected form; the section flips before that lands.
    await win.waitForFunction(() => {
      const vis = (el: Element | null) => !!(el && (el as HTMLElement).offsetParent !== null);
      return vis(document.getElementById('conn-picker')) || vis(document.getElementById('conn-form'));
    }, null, { timeout: 30_000 }).catch(() => {});
  };

  const goHome = async (): Promise<void> => {
    await win.click('.as-nav-item[data-section="home"]', { timeout: 8000 }).catch(() => {});
    await win.waitForTimeout(300);
  };

  // Scoped to `.as-connect-item`: `[data-source]` also matches the Home cards,
  // and it is the RAIL entries this covers.
  const clickRail = async (kind: string): Promise<void> => {
    await goHome();
    await win.click(`.as-connect-item[data-source="${kind}"]`, { timeout: 8000 }).catch(() => {});
    await waitForConnect();
  };

  // Which step of the connect panel is showing, and for whom. `conn-picker` is
  // step 1 (the 35-source grid), `conn-form` is step 2 (one connector's fields).
  const step = () =>
    win.evaluate(() => {
      const vis = (el: Element | null): boolean => !!el && (el as HTMLElement).offsetParent !== null;
      return {
        form: vis(document.getElementById('conn-form')),
        picker: vis(document.getElementById('conn-picker')),
        name: (document.getElementById('conn-chosen-name')?.textContent || '').trim(),
      };
    });

  ok('boot: the hub starts on Home', (await section()) === 'home', `section=${await section()}`);

  // ── The named shortcuts land on their own connector ───────────────────────
  await clickRail('postgres');
  const pg = await step();
  ok('the PostgreSQL shortcut opens the PostgreSQL form, not the whole catalog',
     pg.form && !pg.picker && /postgres/i.test(pg.name), JSON.stringify(pg));

  await clickRail('mysql');
  const my = await step();
  ok('…and MySQL opens MySQL', my.form && !my.picker && /mysql/i.test(my.name), JSON.stringify(my));

  // ── "More…" is the one entry that SHOULD show the full grid ───────────────
  // That is its whole job, and teaching the named entries to preselect must not
  // have cost it.
  await goHome();
  await win.click('#as-connect-more', { timeout: 8000 }).catch(() => {});
  await waitForConnect();
  const more = await step();
  ok('More… still opens the full source picker', more.picker && !more.form, JSON.stringify(more));

  // ── A preselect is a ONE-SHOT handoff ─────────────────────────────────────
  // selectSection('connect') reaches refreshConnPanel WITHOUT going through
  // openConnPanel, so it never clears the pending id itself. If the preselect
  // were sticky, walking into Connect this way right after a named shortcut would
  // reopen that connector's form instead of the picker. (Connect has no nav item
  // of its own now — it is an aliased action under "Data" — so this drives the
  // section switch directly, which is the exact route the router takes.)
  await clickRail('postgres');
  const beforeNav = await step();
  await goHome();
  await win.evaluate(() => { (window as any).selectSection('connect'); });
  await waitForConnect();
  const viaNav = await step();
  ok('entering Connect fresh opens the picker — a shortcut preselect does not stick',
     beforeNav.form && viaNav.picker && !viaNav.form,
     `afterShortcut=${JSON.stringify(beforeNav)} viaNav=${JSON.stringify(viaNav)}`);

  // ── An unknown id must fall back, never open a dead panel ─────────────────
  // The catalog is resolved from the live registry (src/connectors/), so a
  // shortcut id that no longer exists there is a real possibility — a connector
  // can be renamed or dropped without anyone touching the rail. Driving
  // openConnPanel directly is the only way to reach that case: the rail's own
  // ids are all valid, which is exactly why this cannot be clicked into.
  await goHome();
  await win.evaluate(() => { (window as any).openConnPanel('no-such-connector'); });
  await waitForConnect();
  const bogus = await step();
  ok('an unknown connector id falls back to the picker rather than a dead panel',
     bogus.picker && !bogus.form, JSON.stringify(bogus));

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 5).join(' | '));

  await app.close();
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failures) {
      console.error(`${failures} connect smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All connect smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
