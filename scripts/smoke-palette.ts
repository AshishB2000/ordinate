// The command palette, the shortcuts sheet and the native menu — in the REAL app.
//
// The registry's own logic is pinned by scripts/test-commands.ts. What only a
// running app can show is whether the four surfaces that read it are actually
// wired to it:
//
//   ⌘K opens the box · typing finds your records across projects · Enter opens
//   one · `>` runs a command on what you just opened · `?` documents every
//   binding · ⌘1 navigates · and the macOS menu bar carries the same commands
//   with the same accelerators.
//
// The menu assertion is the one that cannot be faked from the renderer: it is
// read out of `Menu.getApplicationMenu()` in MAIN, so it proves the registry
// crossed the bridge and became a real menu rather than a template nobody set.
//
// A fresh userData, so the bundled sample project ("Retail orders" /
// "Retail overview") is there to search for — the same first-launch state
// smoke-sample.ts asserts.
//
//   npm run smoke   (or: node scripts/smoke-palette.js)

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-palette-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

/** ⌘ on macOS, Ctrl everywhere else — the same mapping commands.ts makes. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

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

  // The first paint is a SPLASH — a screenshot there passes every check while
  // proving nothing. Wait it out, then remove it defensively.
  await win.waitForSelector('#splash', { state: 'hidden', timeout: 60_000 }).catch(() => {});
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  await win.waitForSelector('#side-ai-btn', { timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1440, 900); });
  // The ⌘⇧D checks start from light. The app follows the OS appearance, and a
  // Mac on Auto turns dark in the evening — which failed this smoke by the clock.
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  // The sample project is seeded on first launch; the palette searches records
  // through main, so it has to be on disk before anything is typed.
  await win.waitForTimeout(4000);

  /** The rows on screen, in order, as "title | meta". */
  const rows = (): Promise<string[]> => win.evaluate(() =>
    Array.from(document.querySelectorAll('#cp-results .cp-row')).map((r) => {
      const t = r.querySelector('.cp-row-title');
      const m = r.querySelector('.cp-row-meta');
      return ((t && t.textContent) || '') + ' | ' + ((m && m.textContent) || '');
    }));

  // ── ⌘K opens it ─────────────────────────────────────────────────────────
  await win.keyboard.press(MOD + '+K');
  await win.waitForSelector('#cp-overlay:not([hidden])', { timeout: 8000 });
  ok('⌘K opens the palette', await win.locator('#cp-overlay').isVisible());
  ok('…with the caret already in it, so you can type without aiming',
    await win.evaluate(() => !!document.activeElement && document.activeElement.id === 'cp-input'));
  await win.keyboard.press(MOD + '+K');
  await win.waitForSelector('#cp-overlay', { state: 'hidden', timeout: 8000 });
  ok('…and ⌘K again puts it away — the one key that still fires while it is open',
    await win.locator('#cp-overlay').isHidden());
  await win.keyboard.press(MOD + '+K');
  await win.waitForSelector('#cp-overlay:not([hidden])', { timeout: 8000 });

  const empty = await rows();
  ok('…and an empty query is not an empty box — Recent and the top commands are there',
    empty.length > 0, JSON.stringify(empty.slice(0, 4)));
  // The box animates in over --dur-panel; a shot fired at once catches it
  // half-transparent and makes a fine palette look broken in a PR.
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(shotDir, 'palette-empty.png') });

  // ── Typing finds records ────────────────────────────────────────────────
  await win.fill('#cp-input', 'retail');
  await win.waitForFunction(
    () => Array.from(document.querySelectorAll('#cp-results .cp-row-title'))
      .some((t) => /Retail overview/.test(t.textContent || '')),
    undefined, { timeout: 15_000 },
  );
  const found = await rows();
  ok('typing "retail" lists the sample DATASET',
    found.some((r) => /^Retail orders \|/.test(r)), JSON.stringify(found));
  ok('…and the sample DASHBOARD',
    found.some((r) => /^Retail overview \|/.test(r)), JSON.stringify(found));
  ok('…each row saying what it is and which project it is in',
    found.some((r) => /Retail overview \| Dashboard · My project/.test(r)), JSON.stringify(found));
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(shotDir, 'palette-search.png') });

  // ── Enter opens the dashboard ───────────────────────────────────────────
  // Walk the list rather than assuming the dashboard is row one: what is being
  // asserted is that Enter opens the SELECTED record, not a ranking.
  for (let i = 0; i < found.length; i++) {
    const sel = await win.evaluate(() => {
      const el = document.querySelector('#cp-results .cp-row.is-sel .cp-row-title');
      return (el && el.textContent) || '';
    });
    if (sel === 'Retail overview') break;
    await win.keyboard.press('ArrowDown');
  }
  await win.keyboard.press('Enter');
  await win.waitForSelector('#dash-editor:not([hidden])', { timeout: 20_000 });
  ok('Enter opens the selected dashboard', await win.locator('#dash-editor').isVisible());
  ok('…and the palette closed behind it', await win.locator('#cp-overlay').isHidden());

  // ── `>` runs a command on what is now open ──────────────────────────────
  await win.keyboard.press(MOD + '+K');
  await win.waitForSelector('#cp-overlay:not([hidden])', { timeout: 8000 });
  await win.fill('#cp-input', '>add metric');
  await win.waitForFunction(
    () => Array.from(document.querySelectorAll('#cp-results .cp-row-title'))
      .some((t) => /Add a metric/.test(t.textContent || '')),
    undefined, { timeout: 8000 },
  );
  const cmds = await rows();
  ok('">" limits the palette to commands',
    cmds.length > 0 && cmds.every((r) => !/ \| Dashboard · /.test(r)), JSON.stringify(cmds));
  ok('…and "Add a metric" is offered, because a dashboard IS open',
    cmds.some((r) => /^Add a metric \|/.test(r)), JSON.stringify(cmds));
  await win.keyboard.press('Enter');
  // "Add a metric" opens the metric PICKER since the metrics layer (#173); the
  // column dialog this used to wait for is now its "Custom…" row.
  await win.waitForSelector('.mpk-menu', { timeout: 15_000 });
  ok('Enter runs it — the metric picker opens on the open dashboard',
    await win.locator('.mpk-menu').isVisible());
  await win.keyboard.press('Escape');
  await win.waitForSelector('.mpk-menu', { state: 'detached', timeout: 8000 }).catch(() => {});

  // ── `?` opens the sheet, rendered from the registry ─────────────────────
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.keyboard.press('?');
  await win.waitForSelector('#cp-sheet:not([hidden])', { timeout: 8000 });
  ok('"?" opens the shortcuts sheet', await win.locator('#cp-sheet').isVisible());
  const sheet = await win.evaluate(() => {
    const body = document.getElementById('cp-sheet-body')!;
    return {
      groups: Array.from(body.querySelectorAll('.cp-group')).map((g) => g.textContent || ''),
      rows: Array.from(body.querySelectorAll('.cp-sheet-row')).map((r) => {
        const n = r.querySelector('.cp-sheet-name');
        const k = r.querySelector('.kbd');
        return ((n && n.textContent) || '') + ' = ' + ((k && k.textContent) || '');
      }),
    };
  });
  const newDashKey = process.platform === 'darwin' ? '⌘N' : 'Ctrl+N';
  ok('…listing New dashboard with its key, read off the registry',
    sheet.rows.some((r) => r === 'New dashboard = ' + newDashKey), JSON.stringify(sheet.rows.slice(0, 8)));
  ok('…grouped the way the palette and the menus group them',
    sheet.groups.indexOf('Create') >= 0 && sheet.groups.indexOf('Dashboard') >= 0,
    JSON.stringify(sheet.groups));
  ok('…and it documents EVERY command, including ones not available here',
    sheet.rows.length >= 30, String(sheet.rows.length));
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(shotDir, 'palette-shortcuts.png') });
  await win.keyboard.press('Escape');
  // state: 'hidden' — the default waits for VISIBLE, which a hidden box never is.
  await win.waitForSelector('#cp-sheet', { state: 'hidden', timeout: 8000 });
  ok('Escape closes the sheet', await win.locator('#cp-sheet').isHidden());

  // ── ⌘1 navigates ────────────────────────────────────────────────────────
  await win.keyboard.press(MOD + '+1');
  await win.waitForFunction(
    () => (document.querySelector('.hub-body') as HTMLElement).dataset.section === 'home',
    undefined, { timeout: 8000 },
  );
  ok('⌘1 goes Home',
    await win.evaluate(() => (document.querySelector('.hub-body') as HTMLElement).dataset.section === 'home'));
  // Authoring an analysis hides the sidebar (body.an-focus) and "‹ Back" used to
  // be the only way out, because nothing else could navigate. ⌘1 can — so it has
  // to close the analysis on the way, or it strands the user on a Home with no rail.
  ok('…and leaving an open dashboard that way does not strand you in focus mode',
    await win.evaluate(() => !document.body.classList.contains('an-focus')
      && (document.getElementById('app-sidebar') as HTMLElement).offsetParent !== null));

  // ── Both themes, and the selection actually READS in each ───────────────
  // The trap this catches is specific and was live: in light, --surface-1 and
  // --surface-float are BOTH #ffffff, so a selected row painted --surface-1 is
  // a white row on a white box and only the 2px bar survives. No behavioural
  // assertion can see that, so the colours are compared directly — in both
  // themes, because dark is where the floating surface steps up instead.
  const contrast = async (): Promise<any> => win.evaluate(() => {
    const box = document.querySelector('.cp-box') as HTMLElement;
    const sel = document.querySelector('#cp-results .cp-row.is-sel') as HTMLElement;
    return {
      theme: document.documentElement.dataset.theme,
      box: getComputedStyle(box).backgroundColor,
      row: getComputedStyle(sel).backgroundColor,
      bar: getComputedStyle(sel).borderLeftColor,
    };
  });

  await win.keyboard.press(MOD + '+K');
  await win.waitForSelector('#cp-overlay:not([hidden])', { timeout: 8000 });
  await win.waitForTimeout(300);
  const light = await contrast();
  ok('in light, the selected row is a different fill from the box it sits in',
    light.row !== light.box, JSON.stringify(light));

  // An open palette owns the keyboard (commands.ts), so the chord is pressed
  // from neutral ground — which is also the assertion that the rule holds.
  await win.keyboard.press(MOD + '+Shift+D');
  await win.waitForTimeout(400);
  ok('⌘⇧D does NOT fire while the palette is open — the top layer owns the keyboard',
    await win.evaluate(() => document.documentElement.dataset.theme === 'light'));
  await win.keyboard.press('Escape');
  await win.waitForSelector('#cp-overlay', { state: 'hidden', timeout: 8000 });
  await win.keyboard.press(MOD + '+Shift+D');
  await win.waitForFunction(
    () => document.documentElement.dataset.theme === 'dark', undefined, { timeout: 8000 },
  );
  ok('…and it toggles dark mode from the surface underneath',
    await win.evaluate(() => document.documentElement.dataset.theme === 'dark'));
  await win.keyboard.press(MOD + '+K');
  await win.waitForSelector('#cp-overlay:not([hidden])', { timeout: 8000 });
  await win.waitForTimeout(300);
  const dark = await contrast();
  ok('…and the selection still reads against the dark floating surface',
    dark.row !== dark.box, JSON.stringify(dark));
  ok('…with the accent bar in both', light.bar === dark.bar || (!!light.bar && !!dark.bar),
    `${light.bar} / ${dark.bar}`);
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(shotDir, 'palette-dark.png') });
  await win.keyboard.press('Escape');
  await win.waitForSelector('#cp-overlay', { state: 'hidden', timeout: 8000 });
  await win.keyboard.press(MOD + '+Shift+D');
  await win.waitForFunction(
    () => document.documentElement.dataset.theme === 'light', undefined, { timeout: 8000 },
  );

  // ── The native menu is the SAME list ────────────────────────────────────
  // Read in main, off the menu Electron actually holds — a template that was
  // built but never set would pass every renderer-side check.
  const menu: any = await app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu();
    if (!m) return null;
    return m.items.map((i: any) => ({
      label: i.label,
      items: (i.submenu ? i.submenu.items : []).map((s: any) => ({ label: s.label, accel: s.accelerator || '' })),
    }));
  });
  ok('main holds an application menu built from the registry', !!menu, JSON.stringify(menu));
  const dashMenu = (menu || []).find((m: any) => m.label === 'Dashboard');
  ok('…with a "Dashboard" menu', !!dashMenu, JSON.stringify((menu || []).map((m: any) => m.label)));
  const present = dashMenu && dashMenu.items.find((i: any) => i.label === 'Present');
  ok('…carrying Present, bound to the same key the sheet prints',
    !!present && present.accel === 'CommandOrControl+P',
    JSON.stringify(present || (dashMenu && dashMenu.items)));
  const fileMenu = (menu || []).find((m: any) => m.label === 'File');
  ok('…and a File menu with the create commands',
    !!fileMenu && fileMenu.items.some((i: any) => i.label === 'New dashboard'),
    JSON.stringify(fileMenu && fileMenu.items.map((i: any) => i.label)));
  // Edit keeps the platform's own roles: ⌘Z in a text field has to stay the
  // browser's undo, not a card revert (commands.ts, CMD_NATIVE_EDIT_KEYS).
  const editMenu = (menu || []).find((m: any) => m.label === 'Edit');
  ok('…and an Edit menu of native roles, so ⌘Z still undoes typing',
    !!editMenu && editMenu.items.some((i: any) => /Undo/i.test(i.label || '')),
    JSON.stringify(editMenu && editMenu.items.map((i: any) => i.label)));

  // ── Focusing the top bar's search opens the palette ──────────────────────
  await win.click('#global-search', { timeout: 8000 });
  await win.waitForSelector('#cp-overlay:not([hidden])', { timeout: 8000 });
  ok('focusing the top bar search opens the palette — the box keeps its promise',
    await win.locator('#cp-overlay').isVisible());
  await win.keyboard.press('Escape');
  await win.waitForSelector('#cp-overlay', { state: 'hidden', timeout: 8000 });

  ok('no renderer console errors through the whole run', errors.length === 0, errors.join(' | '));

  await app.close();
  console.log('[smoke-palette] artifacts in', shotDir);
}

main().then(() => process.exit(failureCount() ? 1 : 0)).catch((e) => {
  console.error('[smoke-palette] failed —', e);
  process.exit(1);
});
