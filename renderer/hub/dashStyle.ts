// Dashboard STYLE presets — one job: turn an app-owned `{theme, density, accent}`
// into CSS classes, preview it, and apply it. Classic global-scope renderer
// <script> — NO import/export (loaded after dashboards.js, so dashEl /
// dashCurrent / renderDashGrid / markDashDirty / makeModalAccessible are in
// scope at call time).
//
// The model NEVER writes CSS here. It picks one of four NAMED presets and the
// app owns everything those names mean, which is why the whole vocabulary is a
// closed enum on both sides of the IPC boundary.

// ── The vocabulary (mirrors src/analysis/dashboards.ts) ──────────────────────
// A duplicated constant, deliberately: the renderer is classic global scope and
// cannot import from main. scripts/test-dashboardStyleParity.ts asserts the two
// copies are identical, the same way AI_NOT_CONFIGURED is pinned.
// 'auto' declares NO tokens — see hub.css — so a sheet set to it inherits the
// app's [data-theme]. That is the default, and it is why a dark app now has dark
// dashboards: 'clean' pins the light tokens on the sheet container, which was the
// default and so applied to every dashboard nobody had deliberately restyled.
const DASH_THEMES = ['auto', 'clean', 'executive', 'dark'];
const DASH_DENSITIES = ['comfortable', 'compact'];
const DASH_ACCENTS = ['blue', 'teal', 'slate'];
const DASH_STYLE_DEFAULT = { theme: 'auto', density: 'comfortable', accent: 'blue' };

// The picker offers these four. `dense` is still a valid preset the Assistant
// can name; it is simply not a tile, because "compact" is a density and the
// other three tiles are about light and dark.
const DASH_STYLE_PRESET_ORDER = ['auto', 'clean', 'executive', 'dark'];
const DASH_STYLE_PRESETS: Record<string, any> = {
  auto: { theme: 'auto', density: 'comfortable', accent: 'blue' },
  clean: { theme: 'clean', density: 'comfortable', accent: 'blue', chosen: true },
  executive: { theme: 'executive', density: 'comfortable', accent: 'slate', chosen: true },
  dense: { theme: 'auto', density: 'compact', accent: 'blue' },
  dark: { theme: 'dark', density: 'comfortable', accent: 'blue', chosen: true },
};
const DASH_STYLE_LABELS: Record<string, string> = {
  auto: 'Auto', clean: 'Light', executive: 'Executive', dense: 'Dense', dark: 'Dark',
};
const DASH_STYLE_NOTES: Record<string, string> = {
  auto: 'Follows the app — light or dark with your Appearance setting.',
  clean: 'Always light, whatever the app is set to.',
  executive: 'Muted palette, serif figures, more presence.',
  dense: 'Tighter grid and smaller type — more on screen.',
  dark: 'Always dark, whatever the app is set to.',
};

// Renderer-side clamp. Main sanitizes too (src/analysis/dashboards.ts) and its
// copy is the one that reaches disk; this one exists so a record hand-edited to
// junk still PAINTS, instead of composing a class name out of the junk.
function dashSanitizeStyle(raw: any): any {
  const o = raw && typeof raw === 'object' ? raw : {};
  // Same migration main applies (src/analysis/dashboards.ts): a stored 'clean'
  // without `chosen` was written by the old default, not picked, so it reads as
  // 'auto' and follows the app.
  const chosen = o.chosen === true;
  const rawTheme = DASH_THEMES.indexOf(o.theme) >= 0 ? o.theme : DASH_STYLE_DEFAULT.theme;
  return {
    theme: rawTheme === 'clean' && !chosen ? 'auto' : rawTheme,
    density: DASH_DENSITIES.indexOf(o.density) >= 0 ? o.density : DASH_STYLE_DEFAULT.density,
    accent: DASH_ACCENTS.indexOf(o.accent) >= 0 ? o.accent : DASH_STYLE_DEFAULT.accent,
    ...(chosen ? { chosen: true } : {}),
  };
}

function dashStyleClassList(style: any): string[] {
  const s = dashSanitizeStyle(style);
  return ['dash-theme--' + s.theme, 'dash-density--' + s.density, 'dash-accent--' + s.accent];
}

// The three axes are orthogonal CLASSES, so a partial swap would leave two
// theme classes on the element fighting over the cascade by source order. Strip
// every axis class first, then add the new three — never toggle one axis in place.
function applyDashStyleTo(el: HTMLElement | null, style: any): void {
  if (!el) return;
  Array.prototype.slice.call(el.classList)
    .filter((c: string) => /^dash-(theme|density|accent)--/.test(c))
    .forEach((c: string) => el.classList.remove(c));
  dashStyleClassList(style).forEach((c) => el.classList.add(c));
}

/** The style of the open dashboard, always a valid triple. */
function dashCurrentStyle(): any {
  return dashSanitizeStyle(dashCurrent && dashCurrent.style);
}

/** Which preset a triple IS, or '' when the axes have been mixed by hand. */
function dashPresetOf(style: any): string {
  const s = dashSanitizeStyle(style);
  for (const name of DASH_STYLE_PRESET_ORDER) {
    const p = DASH_STYLE_PRESETS[name];
    if (p.theme === s.theme && p.density === s.density && p.accent === s.accent) return name;
  }
  return '';
}

/** Repaint the open editor from `dashCurrent.style`. Safe to call any time. */
function syncDashStyle(): void {
  applyDashStyleTo(dashEl('dash-editor'), dashCurrentStyle());
}

// ── The preview strip ────────────────────────────────────────────────────────
// A thumbnail is a SCHEMATIC of the real grid, not sixteen live Chart.js
// instances: the strip is four tiles wide inside a 340px dock, so a real chart
// lands at ~85px and reads as noise — and the thing being previewed is the
// STYLE, which the schematic carries faithfully because it inherits the same
// token classes. The layout is real (each card's own x/y/w/h), so switching
// preset visibly re-skins the user's actual arrangement.
type DashMiniCard = { type: string; x: number; y: number; w: number; h: number };

/** Descriptors for the open dashboard's current page. */
function dashMiniCardsFromCurrent(): DashMiniCard[] {
  const page = typeof dashCurrentPage === 'function' ? dashCurrentPage() : null;
  const cards = page && Array.isArray(page.cards) ? page.cards : [];
  return cards.map((c: any) => {
    const l = c.layout || {};
    return {
      type: String(c.type || 'visual'),
      x: Number(l.x) || 0, y: Number(l.y) || 0,
      w: Math.max(1, Number(l.w) || 6), h: Math.max(1, Number(l.h) || 4),
    };
  });
}

function dashMiniCardEl(card: DashMiniCard): HTMLElement {
  const el = document.createElement('span');
  el.className = 'dash-mini-card dash-mini-card--' + card.type;
  el.style.gridColumn = (Math.min(card.x, DASH_GRID_COLS - 1) + 1) + ' / span ' +
    Math.min(card.w, DASH_GRID_COLS);
  el.style.gridRow = (card.y + 1) + ' / span ' + card.h;
  if (card.type === 'metric') {
    const v = document.createElement('span');
    v.className = 'dash-mini-metric';
    v.textContent = '1.2K';
    el.appendChild(v);
  } else if (card.type === 'text') {
    for (let i = 0; i < 2; i++) {
      const line = document.createElement('span');
      line.className = 'dash-mini-line';
      el.appendChild(line);
    }
  } else if (card.type === 'control') {
    const pill = document.createElement('span');
    pill.className = 'dash-mini-pill';
    el.appendChild(pill);
  } else {
    // A visual: four bars painted from --chart-1..4, which resolve against THIS
    // thumbnail's own accent class. That only works because chart/token reads
    // are element-scoped (chartPalette.getCSSVar) — the whole reason four
    // differently-styled previews can sit side by side at all.
    const bars = document.createElement('span');
    bars.className = 'dash-mini-bars';
    const heights = [58, 92, 44, 74];
    for (let i = 0; i < 4; i++) {
      const bar = document.createElement('span');
      bar.className = 'dash-mini-bar';
      bar.style.height = heights[i] + '%';
      bar.style.background = 'var(--chart-' + (i + 1) + ')';
      bars.appendChild(bar);
    }
    el.appendChild(bars);
  }
  return el;
}

/**
 * The four-up chooser. `cards` describes the grid to preview, `current` is the
 * selected style, and `onPick` fires with a preset name on every click — the
 * caller decides whether that is a live apply or just a selection.
 */
function buildDashStyleStrip(cards: DashMiniCard[], current: any, onPick: (p: string) => void): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'dash-style-strip';
  strip.setAttribute('role', 'radiogroup');
  strip.setAttribute('aria-label', 'Dashboard style');
  const selected = dashPresetOf(current);
  DASH_STYLE_PRESET_ORDER.forEach((name) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'dash-style-tile';
    tile.setAttribute('role', 'radio');
    tile.setAttribute('aria-checked', name === selected ? 'true' : 'false');
    tile.title = DASH_STYLE_NOTES[name];

    const preview = document.createElement('span');
    preview.className = 'dash-style-preview';
    dashStyleClassList(DASH_STYLE_PRESETS[name]).forEach((c) => preview.classList.add(c));
    const mini = document.createElement('span');
    mini.className = 'dash-mini-grid';
    // An empty dashboard still has to show what the style looks like, so a
    // placeholder arrangement stands in — otherwise every tile is a blank box
    // and the chooser tells the user nothing.
    const shown = cards.length ? cards.slice(0, 6) : [
      { type: 'metric', x: 0, y: 0, w: 4, h: 2 }, { type: 'metric', x: 4, y: 0, w: 4, h: 2 },
      { type: 'metric', x: 8, y: 0, w: 4, h: 2 }, { type: 'visual', x: 0, y: 2, w: 12, h: 4 },
    ];
    shown.forEach((c) => mini.appendChild(dashMiniCardEl(c)));
    preview.appendChild(mini);

    const nameEl = document.createElement('span');
    nameEl.className = 'dash-style-tile-name';
    nameEl.textContent = DASH_STYLE_LABELS[name];

    tile.appendChild(preview);
    tile.appendChild(nameEl);
    tile.addEventListener('click', () => {
      Array.prototype.slice.call(strip.querySelectorAll('.dash-style-tile'))
        .forEach((t: HTMLElement) => t.setAttribute('aria-checked', 'false'));
      tile.setAttribute('aria-checked', 'true');
      onPick(name);
    });
    strip.appendChild(tile);
  });
  return strip;
}

// ── Applying ─────────────────────────────────────────────────────────────────
/**
 * Set the open dashboard's style. `persist` is false while a modal is only
 * PREVIEWING, so Cancel can put the old one back without ever having written.
 * The grid is fully re-rendered because Chart.js reads its colours once, at
 * construction — a class swap alone re-skins the chrome and leaves every chart
 * painted in the outgoing palette.
 */
function setDashStyle(style: any, persist: boolean): void {
  if (!dashCurrent) return;
  // Anything that reaches here came from the picker or the Assistant, so it is a
  // CHOICE — flagged so the 'clean' migration never quietly undoes it.
  dashCurrent.style = dashSanitizeStyle({ ...style, chosen: true });
  syncDashStyle();
  renderDashGrid();
  if (persist) { markDashDirty(); scheduleDashSave(); }
}

function applyDashStylePreset(preset: string): boolean {
  const next = DASH_STYLE_PRESETS[preset];
  if (!dashCurrent || !next) return false;
  setDashStyle(next, true);
  showToast('Style: ' + DASH_STYLE_LABELS[preset]);
  return true;
}

// The Style button. Picking a tile applies LIVE to the dashboard behind the
// modal — that is the preview — and Cancel restores whatever was there when the
// modal opened, which is the "undoable" half of the brief. Nothing is written
// until Apply, so a cancelled preview never reaches disk.
function handleDashStyle(): void {
  if (!dashCurrent) return;
  const before = dashCurrentStyle();
  let picked = dashPresetOf(before) || 'clean';

  const overlay = document.createElement('div');
  overlay.className = 'ws-modal-overlay';
  const box = document.createElement('div');
  box.className = 'ws-modal dash-style-modal';
  const h = document.createElement('h3');
  h.textContent = 'Dashboard style';
  const sub = document.createElement('p');
  sub.className = 'dash-style-sub';
  sub.textContent = 'Applies to this dashboard only, and travels with it when you share.';
  const strip = buildDashStyleStrip(dashMiniCardsFromCurrent(), before, (name) => {
    picked = name;
    setDashStyle(DASH_STYLE_PRESETS[name], false); // preview, not a write
  });

  const actions = document.createElement('div');
  actions.className = 'ws-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-primary';
  apply.textContent = 'Apply';

  let done = false;
  let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
  function close(commit: boolean): void {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (a11y) a11y.release();
    if (commit) applyDashStylePreset(picked);
    else setDashStyle(before, false); // put the preview back
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
    else if (a11y) a11y.onTabKey(e);
  }
  cancel.addEventListener('click', () => close(false));
  apply.addEventListener('click', () => close(true));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
  document.addEventListener('keydown', onKey, true);

  actions.appendChild(cancel);
  actions.appendChild(apply);
  box.appendChild(h);
  box.appendChild(sub);
  box.appendChild(strip);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  a11y = makeModalAccessible(box, 'Dashboard style', apply);
}
