// The persistent shell around the workspace: the Visuals empty state, the
// Connect page's 41 source tiles, Home's shortcut rail and the Capture
// workspace the rail opens.
//
// Split out of smoke-app.ts (see that file's banner). These are the surfaces a
// user sees BEFORE they have anything, and they are exactly the ones a unit
// test cannot speak for: an empty state that renders at zero height, a glyph
// cluster with no <svg> children, an ungated AI door, a nav item bound to a
// stale selector — every one of those passes a DOM-presence check made outside
// a running window, and a real inconsistent build produces them silently, with
// no console error.
//
// A few thousand rows, not a million: nothing on this surface counts them.
//
//   npm run build:ts && node scripts/smoke-shell.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, reloadSmoke, seedProject, finishSmoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

async function main(): Promise<void> {
  const smoke = await launchSmoke('shell');
  const { win, errors, shotDir } = smoke;

  const r = await seedProject(smoke.app, { rows: 5_000 });
  // Reload so the renderer picks up the projects written above.
  await reloadSmoke(smoke);

  await win.evaluate(() => {
    (window as any).__alerts = [];
    window.alert = (m?: any) => { (window as any).__alerts.push(String(m)); };
  });

  // ── The Visuals empty state ───────────────────────────────────────────────
  // The SHARED .ws-empty treatment, not a bespoke dashed box — the point of
  // hoisting those classes. Asserted from a laid-out page: a glyph cluster with
  // zero <svg> children, or an ungated AI door, both pass a DOM-presence check.
  // Against the BARE project, adopted EXPLICITLY: the page only exists for a
  // project with no visuals, and since the Home rebuild boot adopts the newest
  // one (refreshHome → resolveProjectId), so "arrived with nothing adopted" is
  // unreachable. Without it these read a gallery holding two cards.
  await win.evaluate(async (id: string) => {
    await (window as any).adoptProject(id); // MUST await: the click below repaints the gallery
    ([...document.querySelectorAll('.as-nav-item')]
      .find((b) => (b.textContent || '').trim() === 'Visuals') as HTMLElement | undefined)?.click();
  }, r.bareProjectId);
  await win.waitForTimeout(900);
  const vizEmpty = await win.evaluate(() => {
    const box = document.getElementById('viz-empty');
    const art = document.getElementById('viz-empty-art');
    return {
      shared: !!box && box.classList.contains('ws-empty'),
      visible: !!box && box.offsetParent !== null,
      glyphs: art ? art.querySelectorAll('svg').length : 0,
      heading: (document.querySelector('#viz-empty .ws-empty-h')?.textContent || '').trim(),
      aiDisabled: (document.getElementById('viz-empty-ai') as HTMLButtonElement | null)?.disabled,
      hintShown: (document.getElementById('viz-empty-hint') as HTMLElement | null)?.hidden === false,
      countHidden: (document.getElementById('viz-count') as HTMLElement | null)?.hidden,
    };
  });
  ok('the Visuals empty state reuses the shared .ws-empty surface',
     vizEmpty.shared && vizEmpty.visible && vizEmpty.heading === 'No visuals yet',
     JSON.stringify(vizEmpty));
  ok('…with a real chart-glyph cluster, not an empty box',
     vizEmpty.glyphs >= 3, `${vizEmpty.glyphs} glyphs`);
  ok('…the AI door gated + explained with no model, and the count chip hidden at zero',
     vizEmpty.aiDisabled === true && vizEmpty.hintShown && vizEmpty.countHidden === true,
     JSON.stringify(vizEmpty));

  // An empty page that only DESCRIBES the next action is still a blank page.
  // The band offers the project's real datasets, and — the part worth pinning —
  // it must not claim "No data yet" to someone who has data: the bare project
  // has one dataset and no visuals, which is exactly that case.
  const startBand = await win.evaluate(() => {
    const band = document.getElementById('viz-start');
    const cards = [...document.querySelectorAll('.viz-ds-card')] as HTMLElement[];
    return {
      visible: !!band && band.offsetParent !== null,
      cards: cards.length,
      noDataCard: !!document.querySelector('.viz-ds-none'),
      first: (cards[0]?.textContent || '').replace(/\s+/g, ' ').trim(),
      // The card, the band and the grid must share one left and one right edge
      // whichever of them is on screen. A capped/centred card silently breaks
      // that against the full-width band beneath it, and the misalignment is
      // the kind of thing only a measurement catches.
      edges: (() => {
        const card = document.getElementById('viz-empty');
        const band = document.getElementById('viz-start');
        if (!card || !band) return null;
        const c = card.getBoundingClientRect();
        const b = band.getBoundingClientRect();
        return { dl: Math.round(Math.abs(c.left - b.left)), dr: Math.round(Math.abs(c.right - b.right)) };
      })(),
      cardH: Math.round(document.getElementById('viz-empty')?.getBoundingClientRect().height || 0),
    };
  });
  ok('…and a "Start from a dataset" band offering the project\'s real datasets',
     startBand.visible && startBand.cards > 0 && !startBand.noDataCard,
     JSON.stringify(startBand));
  ok('…listing rows and columns per dataset, not just a name',
     /rows · \d+ columns/.test(startBand.first), `"${startBand.first}"`);
  ok('…edge-aligned with the empty card above it, left and right',
     !!startBand.edges && startBand.edges.dl === 0 && startBand.edges.dr === 0,
     JSON.stringify(startBand.edges));
  ok('…and the card reads as a panel, not a strip',
     startBand.cardH >= 200, `${startBand.cardH}px tall`);

  // Back to the main project below, gallery repainted with it.
  await win.evaluate(async (id: string) => {
    await (window as any).adoptProject(id); (window as any).selectSection('visuals');
  }, r.projectId);
  await win.waitForTimeout(900);

  // "+ New visual" used to alert "Open a project first" and stop — a dead end,
  // since projects are demoted and there is no nav picker to send anyone to.
  // That branch needs a null currentProjectId, unreachable now, so what is left
  // to pin is the outcome: the popup opens and nothing alerts.
  await win.evaluate(() => (document.getElementById('viz-new-btn') as HTMLElement)?.click());
  await win.waitForTimeout(2000);
  const noProject = await win.evaluate(() => ({
    alerts: (window as any).__alerts as string[],
    modalOpen: !!document.querySelector('.vn-modal'),
  }));
  ok('+ New visual opens the popup instead of a dead end, and never alerts',
     noProject.modalOpen && noProject.alerts.length === 0, JSON.stringify(noProject));
  await win.evaluate(() => (document.querySelector('.js-vn-cancel') as HTMLElement)?.click());
  await win.waitForTimeout(400);

  await win.evaluate(async () => {
    // Connect is its own SECTION now, not an overlay over the capture surface, so
    // opening it IS the navigation. The old follow-up selectSection('sources')
    // revealed .main *underneath* the overlay; today it navigates straight back
    // off the page and every tile below this point is present but invisible.
    (window as any).selectSection('connect');
    await (window as any).refreshConnPanel();
  });
  await win.waitForTimeout(300);

  // The point of the change: Connect is the WHOLE page. Asserting the tiles
  // render is not enough — they rendered before too, framed by a Welcome header
  // and a captures column that had nothing to do with picking a data source.
  // offsetParent is null for a display:none subtree, so this catches the panel
  // being reparented back under .main as well as the CSS rule being dropped.
  const dataPageAlone = await win.evaluate(() => {
    const shown = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      return !!el && el.offsetParent !== null;
    };
    return {
      connect: shown('#conn-panel'),
      datasetList: shown('#ws-datasets'),
      capturePage: shown('#ws-capture'),
      navActive: !!document.querySelector('.as-nav-item.active[data-section="datasets"]'),
    };
  });
  ok('the Data page renders Connect ALONE — no other section beside it',
    dataPageAlone.connect && !dataPageAlone.datasetList && !dataPageAlone.capturePage,
    JSON.stringify(dataPageAlone));
  // Connect is an ACTION inside the Data area, so the "Data" nav item (which
  // points at datasets) stays lit here via its data-section-alt="connect".
  ok('...with the Data nav item marked active', dataPageAlone.navActive);

  // Close must land somewhere real. Before, it just un-hid an overlay and left
  // whatever was underneath; now it is a navigation, and getting it wrong
  // strands the user on a hidden section with an empty stage.
  const closeReturns = await win.evaluate(() => {
    (window as any).selectSection('home');
    (window as any).selectSection('connect');
    (window as any).closeConnPanel();
    return (document.querySelector('.hub-body') as HTMLElement)?.dataset.section;
  });
  ok('Close returns to the previous view', closeReturns === 'home', `landed on ${closeReturns}`);
  await win.evaluate(async () => {
    (window as any).selectSection('connect');
    await (window as any).refreshConnPanel();
  });
  await win.waitForTimeout(200);

  const logoPicker = await win.evaluate(() => {
    const tiles = [...document.querySelectorAll<HTMLButtonElement>('.conn-tile')];
    const byId = (id: string) => document.querySelector<HTMLButtonElement>(`.conn-tile[data-connector-id="${id}"]`);
    const redshift = byId('amazon-redshift');
    const postgres = byId('postgres');
    const sqlserver = byId('sqlserver');
    const addedLocalIds = ['azure-sql', 'oracle', 'starrocks', 'csv-folder'];
    const fallbackIds = tiles
      .filter((tile) => tile.querySelector('.conn-logo-fallback'))
      .map((tile) => tile.dataset.connectorId || '');
    const undrawnIds = tiles
      .filter((tile) => !tile.querySelector('.conn-logo svg, .conn-logo img'))
      .map((tile) => tile.dataset.connectorId || '');
    return {
      count: tiles.length,
      everyTileHasLogo: tiles.every((tile) => !!tile.querySelector('.conn-logo')),
      redshiftIsImage: !!redshift?.querySelector('.conn-logo img[src^="data:image/png;base64,"]'),
      postgresIsSvg: !!postgres?.querySelector('.conn-logo svg path'),
      sqlserverIsImage: !!sqlserver?.querySelector('.conn-logo img[src^="data:image/svg+xml;base64,"]'),
      addedLocalImages: addedLocalIds.every((id) =>
        !!byId(id)?.querySelector('.conn-logo img[src^="data:image/"]')),
      fallbackIds,
      undrawnIds,
      logosDecorative: tiles.every((tile) => tile.querySelector('.conn-logo')?.getAttribute('aria-hidden') === 'true'),
    };
  });
  ok('all 41 connector tiles have a logo block', logoPicker.count === 41 && logoPicker.everyTileHasLogo, JSON.stringify(logoPicker));
  ok('Redshift uses the supplied image and PostgreSQL uses a bundled glyph',
    logoPicker.redshiftIsImage && logoPicker.postgresIsSvg, JSON.stringify(logoPicker));
  ok('all catalog sources use real marks instead of normal fallback badges',
    logoPicker.sqlserverIsImage && logoPicker.addedLocalImages &&
      logoPicker.fallbackIds.length === 0 &&
      logoPicker.undrawnIds.length === 0,
    JSON.stringify(logoPicker));
  ok('connector logos are decorative', logoPicker.logosDecorative);

  const originalTheme = await win.evaluate(() =>
    document.documentElement.getAttribute('data-theme'));
  const catalogShots: string[] = [];
  for (const theme of ['light', 'dark']) {
    await win.evaluate((nextTheme) =>
      document.documentElement.setAttribute('data-theme', nextTheme), theme);
    const shot = path.join(shotDir, `data-source-logos-${theme}.png`);
    await win.screenshot({ path: shot });
    catalogShots.push(shot);
  }
  await win.evaluate((theme) => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }, originalTheme);
  ok('data-source logo screenshots captured in light and dark themes',
    catalogShots.every((shot) => fs.existsSync(shot) && fs.statSync(shot).size > 5000),
    catalogShots.join(' | '));

  const brokenImageFallback = await win.evaluate(() => {
    const redshiftLogo = document.querySelector<HTMLElement>(
      '.conn-tile[data-connector-id="amazon-redshift"] .conn-logo',
    );
    redshiftLogo?.querySelector('img')?.dispatchEvent(new Event('error'));
    return {
      isFallback: redshiftLogo?.classList.contains('conn-logo-fallback') || false,
      text: redshiftLogo?.textContent || '',
      hasImage: !!redshiftLogo?.querySelector('img'),
    };
  });
  ok('a malformed connector image falls back to deterministic initials',
    brokenImageFallback.isFallback && brokenImageFallback.text === 'AR' && !brokenImageFallback.hasImage,
    JSON.stringify(brokenImageFallback));

  await win.click('.conn-tile[data-connector-id="amazon-redshift"]');
  const chosenHasLogo = await win.evaluate(() =>
    !!document.querySelector('#conn-chosen-logo img[src^="data:image/png;base64,"]'));
  ok('the selected-source header repeats its logo', chosenHasLogo);
  const brokenChosenImageFallback = await win.evaluate(() => {
    const chosenLogo = document.querySelector<HTMLElement>('#conn-chosen-logo');
    chosenLogo?.querySelector('img')?.dispatchEvent(new Event('error'));
    return {
      isFallback: chosenLogo?.classList.contains('conn-logo-fallback') || false,
      text: chosenLogo?.textContent || '',
      hasImage: !!chosenLogo?.querySelector('img'),
    };
  });
  ok('a malformed selected-source image falls back to deterministic initials',
    brokenChosenImageFallback.isFallback && brokenChosenImageFallback.text === 'AR' &&
      !brokenChosenImageFallback.hasImage,
    JSON.stringify(brokenChosenImageFallback));
  await win.click('#conn-close-btn');
  await win.evaluate(() => { (window as any).selectSection('home'); });

  // ── Home view coverage (regression guard) ─────────────────────────────────
  // The persistent sidebar is the FIRST thing every user sees, yet nothing here
  // ever clicked it — the suite reloaded then drove the workspace via
  // openWorkspace(), so a home whose controls were all bound to stale selectors
  // would ship GREEN. A real inconsistent/stale build does exactly that, and
  // silently (no console error). So click REAL controls and assert each produces
  // its effect. A dead (unbound) or covered (overlay) button leaves the effect
  // absent, which fails loudly here.
  const homeSection = () =>
    win.evaluate(() => document.querySelector('.hub-body')?.getAttribute('data-section'));

  const homeLogos = await win.evaluate(() => {
    const hosts = [...document.querySelectorAll('.as-connect-item .as-source-logo')];
    return {
      count: hosts.length,
      allDrawn: hosts.every((el) => !!el.querySelector('svg, img')),
      oldDots: document.querySelectorAll('.as-connect-item .as-dot').length,
      postgresSvg: !!document.querySelector(
        '.as-source-logo[data-logo-id="postgres"] svg',
      ),
      mysqlSvg: !!document.querySelector(
        '.as-source-logo[data-logo-id="mysql"] svg',
      ),
      pasteSvg: !!document.querySelector(
        '.as-source-logo[data-logo-id="home-paste"] svg path[fill="currentColor"]',
      ),
      captureImg: document.querySelector(
        '.as-source-logo[data-logo-id="home-capture"] img',
      )?.getAttribute('src') === 'assets/connectors/screenchart.png',
    };
  });
  ok('home: Connect shortcuts use five real source or action marks',
    homeLogos.count === 5 && homeLogos.allDrawn && homeLogos.oldDots === 0 &&
      homeLogos.postgresSvg && homeLogos.mysqlSvg && homeLogos.pasteSvg &&
      homeLogos.captureImg,
    JSON.stringify(homeLogos));

  // The strapline under the Connect cards ("Press ⌘⌥S … No model configured …
  // Your data stays on this machine.") was removed. Asserting the TEXT is gone
  // rather than the element, because a future rewrite could reintroduce the
  // copy under a different class and the element check would not notice.
  //
  // The hotkey assertion is the load-bearing half. That strapline was the only
  // thing on Home printing the REAL configured shortcut — `fillDiscover()` wrote
  // it into `#home-disc-hotkey`. The "Grab it off your screen" card had a
  // HARDCODED ⌘⌥S, so deleting the line naively would have left a rebound
  // hotkey silently wrong on the front page. The id moved onto the card; this
  // proves it is still being filled and not just present in the markup.
  const homeStrapline = await win.evaluate(() => {
    const text = document.body.innerText || '';
    const kbd = document.getElementById('home-disc-hotkey');
    return {
      machineText: text.includes('stays on this machine'),
      noModelText: text.includes('No model configured'),
      staleClass: !!document.querySelector('.home-discover-line'),
      staleAiSpan: !!document.getElementById('home-disc-ai'),
      hotkey: kbd ? (kbd.textContent || '').trim() : null,
      // fillDiscover() is async; a still-default value on a machine whose hotkey
      // IS the default is indistinguishable from "never ran", so assert only
      // that something non-empty was rendered into it.
      hotkeyFilled: !!(kbd && (kbd.textContent || '').trim().length > 0),
    };
  });
  ok('home: the strapline under the Connect cards is gone',
    !homeStrapline.machineText && !homeStrapline.noModelText &&
      !homeStrapline.staleClass && !homeStrapline.staleAiSpan,
    JSON.stringify(homeStrapline));
  ok('home: …but the capture card still prints the REAL hotkey, not a hardcoded one',
    homeStrapline.hotkeyFilled, `hotkey=${homeStrapline.hotkey}`);

  const homeShots: string[] = [];
  for (const theme of ['light', 'dark']) {
    await win.evaluate((nextTheme) =>
      document.documentElement.setAttribute('data-theme', nextTheme), theme);
    const shot = path.join(shotDir, `home-source-logos-${theme}.png`);
    await win.screenshot({ path: shot });
    homeShots.push(shot);
  }
  await win.evaluate((theme) => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }, originalTheme);
  ok('home source-logo screenshots captured in light and dark themes',
    homeShots.every((shot) => fs.existsSync(shot) && fs.statSync(shot).size > 5000),
    homeShots.join(' | '));

  // ── "Screenshot" is an ACTION, and the capture shell is gone ──────────────
  // The rail item used to open a full-screen capture SHELL — its own sidebar,
  // its own search, its own settings gear — that the workspace nav could not
  // reach. It now simply takes a screenshot, and a capture lands on a page in
  // this workspace like every other record. The capture WALK (stubbing the
  // image and the model) is scripts/smoke-capture.ts; what this file asserts
  // is that the second shell no longer exists to come back.
  const noSecondShell = await win.evaluate(() => ({
    capturesColumn: document.querySelectorAll('.cap-history').length,
    captureSidebar: document.querySelectorAll('aside.sidebar').length,
    captureSearch: document.querySelectorAll('#cap-search').length,
    secondGear: document.querySelectorAll('#settings-gear-cap').length,
    oldCaptureView: document.querySelectorAll('#capture-view').length,
    focusModeRule: document.body.classList.contains('cap-focus'),
    capturePage: document.querySelectorAll('#ws-capture[data-section="capture"]').length,
    capturesTab: document.querySelectorAll('#ds-tab-captures').length,
  }));
  ok('the capture shell is gone — no second sidebar, search, gear or capture view',
    noSecondShell.capturesColumn === 0 && noSecondShell.captureSidebar === 0
      && noSecondShell.captureSearch === 0 && noSecondShell.secondGear === 0
      && noSecondShell.oldCaptureView === 0 && !noSecondShell.focusModeRule,
    JSON.stringify(noSecondShell));
  ok('…replaced by a capture SECTION and a Captures tab under Data',
    noSecondShell.capturePage === 1 && noSecondShell.capturesTab === 1,
    JSON.stringify(noSecondShell));

  // The execution-mode picker lived in the capture header, which was its only
  // opener. Deleting that header must not have deleted the picker.
  const execDoor = await win.evaluate(() => {
    const b = document.getElementById('exec-mode-btn-cap');
    return { exists: !!b, visible: !!(b && (b as HTMLElement).offsetParent !== null) };
  });
  ok('the execution-mode picker survived the shell, in the top bar',
    execDoor.exists && execDoor.visible, JSON.stringify(execDoor));

  // The chip is only a PICTURE of the hotkey; the shortcut is registered in
  // main. "Removed the chip" and "unregistered the shortcut" look identical on
  // screen, so assert the hotkey still resolves.
  const hotkeyAlive = await win.evaluate(() => (window as any).hub.getHotkeyLabel()
    .then((r: any) => !!(r && (typeof r === 'string' ? r : r.label))).catch(() => false));
  ok('dropping the ⌘⌥S chip did not unregister the hotkey', hotkeyAlive);

  await win.evaluate(() => { (window as any).selectSection('home'); });
  await win.waitForTimeout(400);

  await win.click('#settings-gear', { timeout: 4000 }).catch(() => {});
  await win.waitForTimeout(300);
  const settingsOpened = await win.evaluate(() => {
    const m = document.getElementById('settings-menu');
    return !!m && m.hidden === false;
  });
  ok('home: the Settings gear opens its menu', settingsOpened);
  await win.keyboard.press('Escape').catch(() => {});
  await win.waitForTimeout(200);

  await win.click('.as-nav-item[data-section="visuals"]', { timeout: 4000 }).catch(() => {});
  await win.waitForTimeout(400);
  const navSection = await homeSection();
  ok('home: a sidebar nav item switches the section', navSection === 'visuals', `section=${navSection}`);

  await win.click('.as-nav-item[data-dock-toggle]', { timeout: 4000 }).catch(() => {}); // Assistant nav TOGGLES the dock now (page merged in); ask-bar→dock is smoke-dock
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 8000 }).catch(() => {});
  ok('home: the Assistant nav item toggles the dock, not a dead section', (await win.locator('.as-nav-item[data-dock-toggle]').count()) === 1 && (await win.locator('.as-nav-item[data-section="explore"]').count()) === 0 && (await win.locator('#dk-panel').isVisible()) && (await homeSection()) !== 'explore');
  await win.evaluate(() => { (window as any).dkSetOpen(false); });

  // Back to Home so the project-open flow below starts from a clean state.
  await win.click('.as-nav-item[data-section="home"]', { timeout: 4000 }).catch(() => {});
  await win.waitForTimeout(300);

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await smoke.close();
}

main()
  .then(() => finishSmoke('shell', failureCount()))
  .catch((err) => {
    console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  });
