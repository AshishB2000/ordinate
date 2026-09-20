// Design screenshots — every surface, both themes, two widths, from the REAL app.
//
// This is NOT a CI gate and is deliberately absent from run-smokes.ts: it
// regenerates the committed design artefacts under docs/design/ on demand,
// which is why the name escapes both the `test-*` and `smoke-*` discovery
// globs. What it does borrow from the smokes is the part that makes a
// screenshot worth anything:
//
//   · the SPLASH wait (launchSmoke) — the first paint is a loading screen, and
//     a shot taken there passes every size and DOM check while proving nothing;
//   · a real element of the surface waited for before every shot, so a shot is
//     never of a half-drawn pane;
//   · the console/pageerror capture — a surface that threw on the way in must
//     not be filed as a design reference.
//
// Every surface is reached by CLICKING the app's own controls (the nav items,
// a dataset row, a dashboard card, the Agent toggle, the gear), and the theme
// is switched through the real Appearance segment, so what is photographed is
// what a user gets. The one thing set behind the UI's back is the active
// project — session state, not a surface.
//
//   npm run shoot:design
//   ORDINATE_DESIGN_SHOT_DIR=/tmp/shots node scripts/shoot-design.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, finishSmoke, REPO, type Smoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];

const OUT = process.env.ORDINATE_DESIGN_SHOT_DIR || path.join(REPO, 'docs', 'design');
const HEIGHT = 900;
const WIDTHS = [1440, 1100];
const THEMES: ('light' | 'dark')[] = ['light', 'dark'];

// ── Small DOM driver ────────────────────────────────────────────────────────
// Everything below queries the page rather than the app: a surface that cannot
// be reached is reported as a skip, never faked by forcing DOM state.

/** Click the first on-screen match. False when it is absent or hidden. */
async function click(win: Win, sel: string): Promise<boolean> {
  return win.evaluate((s: string) => {
    const el = document.querySelector(s) as HTMLElement | null;
    // getClientRects(), not offsetParent: a position:fixed overlay has a null
    // offsetParent whether it is showing or not.
    if (!el || el.getClientRects().length === 0) return false;
    el.click();
    return true;
  }, sel);
}

/** Wait for `sel` to be on screen; false on timeout rather than throwing. */
async function onScreen(win: Win, sel: string, ms = 12_000): Promise<boolean> {
  try {
    await win.waitForFunction((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      return !!el && el.getClientRects().length > 0;
    }, sel, { timeout: ms });
    return true;
  } catch {
    return false;
  }
}

/**
 * Switch the theme through the gear menu's Appearance segment — the same path
 * smoke-theme drives, so config.themePreference, main's resolve,
 * applyEffectiveTheme and every redraw are what produced the pixels.
 */
async function setTheme(win: Win, pref: 'light' | 'dark'): Promise<boolean> {
  if (!(await click(win, '#settings-gear'))) return false;
  await win.waitForTimeout(500);
  const hit = await win.evaluate((p: string) => {
    const opt = [...document.querySelectorAll('.menu-seg-opt[data-theme]')]
      .find((e) => (e as HTMLElement).dataset.theme === p && (e as HTMLElement).offsetParent) as HTMLElement | undefined;
    if (!opt) return false;
    opt.click();
    return true;
  }, pref);
  await win.waitForTimeout(1500); // the theme change redraws every live chart
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
  return hit;
}

/** Leave the dashboard workbench by its Back button — the only way out. */
async function leaveEditor(win: Win): Promise<void> {
  const left = await win.evaluate(() => {
    if (!document.body.classList.contains('an-focus')) return false;
    const back = [...document.querySelectorAll('.dash-editor-head button')]
      .find((b) => /Back/.test(b.textContent || '')) as HTMLElement | undefined;
    if (!back) return false;
    back.click();
    return true;
  });
  if (left) await win.waitForTimeout(1500);
}

/** Dismiss whatever is layered over a surface: the settings panel, the dock. */
async function closeOverlays(win: Win): Promise<void> {
  const closed = await win.evaluate(() => {
    let any = false;
    // showSettingsPanel() sets style.display = 'flex'; there is no hidden attr.
    const stp = document.getElementById('settings-panel') as HTMLElement | null;
    if (stp && stp.style.display && stp.style.display !== 'none') {
      (document.getElementById('stp-close') as HTMLElement | null)?.click();
      any = true;
    }
    const dock = document.getElementById('dk-panel') as HTMLElement | null;
    if (dock && !dock.hidden) {
      (document.getElementById('side-ai-btn') as HTMLElement | null)?.click();
      any = true;
    }
    // The dataset explorer takes the whole Data section, so an open one hides
    // the list every other Data shot is of.
    const exp = document.getElementById('ds-explorer') as HTMLElement | null;
    if (exp && !exp.hidden) {
      (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click();
      any = true;
    }
    return any;
  });
  if (closed) await win.waitForTimeout(700);
}

// ── The surfaces ────────────────────────────────────────────────────────────

interface Surface {
  /** The <surface> half of the filename. */
  name: string;
  /** Navigate there. False means "could not be reached", reported as a skip. */
  open: () => Promise<boolean>;
  /** Extra wait before the shutter — charts and maps draw async. */
  settle?: number;
}

function surfaces(win: Win): Surface[] {
  /** A top-level section, from a real nav click. */
  const nav = async (section: string, ready: string): Promise<boolean> => {
    await leaveEditor(win);
    await closeOverlays(win);
    if (!(await click(win, '.as-nav-item[data-section="' + section + '"]'))) return false;
    return onScreen(win, ready);
  };

  return [
    { name: 'home', open: () => nav('home', '#home-greet') },

    // The list view. Either state is a real surface, so an empty project still
    // photographs rather than crashing.
    {
      name: 'data',
      open: () => nav('datasets', '#ds-saved-list .ds-saved-item, #ds-saved-empty'),
    },

    // One dataset open — the row IS the control, so this is an ordinary click.
    {
      name: 'dataset',
      settle: 1800,
      open: async () => {
        if (!(await nav('datasets', '#ds-saved-list .ds-saved-item'))) return false;
        if (!(await click(win, '#ds-saved-list .ds-saved-item'))) return false;
        return onScreen(win, '#ds-explorer-scroll table');
      },
    },

    { name: 'visuals', open: () => nav('visuals', '#viz-grid .viz-card, #viz-empty') },

    // The section id stays "analyses" internally; the surface is Dashboards.
    { name: 'dashboards', open: () => nav('analyses', '#an-list .an-card, #an-list-empty') },

    {
      name: 'dashboard-editor',
      settle: 3500, // every tile's chart, and any map, draws after the card does
      open: async () => {
        if (!(await nav('analyses', '#an-list .an-card'))) return false;
        if (!(await click(win, '#an-list .an-card .an-card-body'))) return false;
        return onScreen(win, '#dash-grid .dash-card');
      },
    },

    // The Agent dock, over whatever the previous surface left behind (the
    // Dashboards list). #side-ai-btn is DISABLED where the dock is suppressed,
    // so a click there is a no-op and this reports a skip.
    {
      name: 'dock',
      open: async () => {
        await leaveEditor(win);
        await closeOverlays(win);
        if (!(await click(win, '#side-ai-btn'))) return false;
        return onScreen(win, '#dk-panel');
      },
    },

    // The gear opens the MENU; the menu's Settings row opens the full-window
    // panel, which is the surface worth photographing.
    {
      name: 'settings',
      open: async () => {
        await closeOverlays(win);
        if (!(await click(win, '#settings-gear'))) return false;
        if (!(await onScreen(win, '#sm-settings'))) return false;
        if (!(await click(win, '#sm-settings'))) return false;
        return onScreen(win, '#stp-title');
      },
    },
  ];
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const s = await launchSmoke('design');
  const { win, app, errors } = s;
  const written: string[] = [];

  // The bundled SAMPLE project, not a seeded million rows: these are design
  // references, and the sample is the state a new user actually sees.
  const sample = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const analysis = req('./src/analysis/analysis.js');
    const list = await projects.listProjects();
    for (const p of list) {
      const ds = await datasets.listDatasets(p.id);
      if (ds.length) {
        return { id: p.id, name: p.name, datasets: ds.length, dashboards: (await analysis.listAnalyses(p.id)).length };
      }
    }
    return null;
  });
  ok('the bundled sample project is there to shoot', Boolean(sample), JSON.stringify(sample));
  if (!sample) { await s.close(); return; }
  console.log('   sample: ' + JSON.stringify(sample));

  // Session state, not a surface: adopt the project without moving section, the
  // same call the Home rows make. openWorkspace() would bounce us to Sources.
  await win.evaluate(async (id: string) => { await (window as any).adoptProject(id); }, sample.id);
  await win.waitForTimeout(1200);

  for (const theme of THEMES) {
    ok(`the Appearance control offers ${theme}`, await setTheme(win, theme));
    for (const width of WIDTHS) {
      await win.setViewportSize({ width, height: HEIGHT });
      await win.waitForTimeout(800); // reflow, and the <1100px dock scrim
      for (const surface of surfaces(win)) {
        const label = `${surface.name}-${theme}-${width}`;
        if (!(await surface.open())) {
          ok(`SKIPPED ${label} — surface not reachable on the sample project`, true);
          continue;
        }
        await win.waitForTimeout(surface.settle ?? 900);
        const file = path.join(OUT, label + '.png');
        await win.screenshot({ path: file });
        const bytes = fs.statSync(file).size;
        ok(`${label}.png (${bytes} bytes)`, bytes > 0);
        written.push(label + '.png');
      }
      await closeOverlays(win);
    }
  }

  ok('no renderer console errors across every surface', errors.length === 0,
    errors.slice(0, 5).join(' | '));
  console.log('\n' + written.length + ' shot(s) in ' + OUT);
  await s.close();
}

void main()
  .catch((err) => { ok('unexpected error', false, err && err.stack ? err.stack : err); })
  .then(() => {
    finishSmoke('design', failureCount());
    process.exit(0);
  });
