'use strict';

// Settings → Appearance → Themes → the EDITOR: one theme's fonts, base palette,
// accent and eight-colour chart ramp, card style, KPI style and density, with
// a live thumbnail of the sample dashboard and a contrast warning beside every
// colour that falls under its floor. Classic global-scope <script>: no
// import/export. Loads after themeSettings.js (its list view and row helpers),
// themeApply.js (applyThemeTokens) and chartPalette.js, whose colour helpers
// (hexToHsl, hslToHex, paletteFromSeed, brandWalk, brandContrast, brandRgba)
// derive the supporting shades — called here, never modified.
//
// The editor works on a DRAFT. Nothing reaches main until Save, which sends the
// whole record through window.hubThemes.save — main re-validates every token —
// and a theme with contrast warnings saves like any other: they are advice.

let teDraft: { id: string; name: string; tokens: any } | null = null;

const TE_DENSITY: Record<string, [number, number]> = { comfortable: [12, 48], compact: [8, 36] };

function teHex(v: any, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;
}

/** `a` moved toward `b` by `t` (0–1), per channel. */
function teMix(a: string, b: string, t: number): string {
  const ch = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = ch(a);
  const y = ch(b);
  return '#' + x.map((c, i) => Math.round(c + (y[i] - c) * t).toString(16).padStart(2, '0')).join('');
}

// ── Derived shades ───────────────────────────────────────────────────────────
// The editor exposes four base colours, but a sheet reads fourteen (card heads,
// insets, three text weights, three border weights…). Leaving those at a
// preset's values would put a light --surface-2 inside a dark theme — the
// white-boxes bug test-dashboardStyleCss.ts guards for the presets — so editing
// a base colour re-derives the whole family from the four. A duplicate keeps
// its built-in's exact values until then.
function teDeriveBase(t: any): void {
  const bg = teHex(t['--bg'], '#f7f7f8');
  const surface = teHex(t['--surface'], '#ffffff');
  const text = teHex(t['--text'], '#18181b');
  const border = teHex(t['--border'], '#e5e7eb');
  const dark = themeModel.isDark(bg);
  Object.assign(t, {
    '--surface-1': surface,
    '--surface-float': dark ? teMix(surface, text, 0.04) : surface,
    '--surface-2': teMix(surface, text, 0.04),
    '--surface-3': teMix(surface, text, 0.08),
    '--inset': teMix(bg, text, 0.03),
    '--titlebar': teMix(bg, surface, 0.5),
    '--text-strong': teMix(text, dark ? '#ffffff' : '#000000', 0.5),
    '--muted': teMix(text, surface, 0.45),
    '--text-dim': teMix(text, surface, 0.58),
    '--text-faint': teMix(text, surface, 0.72),
    '--border-2': teMix(border, text, 0.1),
    '--border-3': teMix(border, text, 0.22),
    '--border-hairline': brandRgba(text, dark ? 0.1 : 0.08),
  });
}

function teDeriveAccent(t: any): void {
  const accent = teHex(t['--accent'], '#2563eb');
  const dark = themeModel.isDark(teHex(t['--surface'], '#ffffff'));
  const hsl = hexToHsl(accent);
  Object.assign(t, {
    '--accent-2': hsl ? hslToHex(hsl.h, hsl.s, Math.max(0, hsl.l - 0.07)) : accent,
    '--accent-soft': brandRgba(accent, dark ? 0.16 : 0.08),
    '--accent-line': brandRgba(accent, dark ? 0.32 : 0.22),
    '--focus-ring': brandRgba(accent, 0.4),
    '--chart-accent': accent,
    // Ink ON the accent (a primary button's label): white while it reads.
    '--accent-ink': brandContrast(accent, '#ffffff') >= 3 ? '#ffffff' : '#0f1117',
  });
}

/** The ramp from the accent: its hue family, each walked to 3:1 on THIS theme's surface. */
function teDeriveRamp(t: any): void {
  const accent = teHex(t['--accent'], '#2563eb');
  const surface = teHex(t['--surface'], '#ffffff');
  const dir = themeModel.isDark(surface) ? 1 : -1;
  paletteFromSeed(accent, 8).forEach((c, i) => {
    t['--chart-' + (i + 1)] = i === 0 ? accent : brandWalk(c, dir as -1 | 1, (h) => brandContrast(h, surface) >= 3);
  });
}

// ── Controls ─────────────────────────────────────────────────────────────────

function teSec(title: string, desc: string, ...children: HTMLElement[]): HTMLElement {
  const sec = sfEl('section', 'te-sec');
  sec.appendChild(sfEl('h4', 'te-sec-h', title));
  if (desc) sec.appendChild(sfEl('p', 'te-sec-d', desc));
  children.forEach((c) => sec.appendChild(c));
  return sec;
}

function teField(label: string, ...controls: HTMLElement[]): HTMLElement {
  const row = sfEl('div', 'te-field');
  row.appendChild(sfEl('span', 'te-field-l', label));
  const c = sfEl('div', 'te-field-c');
  controls.forEach((x) => c.appendChild(x));
  row.appendChild(c);
  return row;
}

function teSet(token: string, value: any, derive?: (t: any) => void): void {
  if (!teDraft) return;
  teDraft.tokens[token] = value;
  if (derive) derive(teDraft.tokens);
  teRefresh();
}

/** A colour: native picker, hex field, and the contrast warning beside it. */
function teColorField(token: string, label: string, derive?: (t: any) => void): HTMLElement {
  const wrap = sfEl('div', 'te-color');
  wrap.dataset.token = token;
  const id = 'te-c-' + token.slice(2);
  const pick = sfEl<HTMLInputElement>('input', 'te-color-input');
  pick.type = 'color';
  pick.id = id;
  const name = sfEl<HTMLLabelElement>('label', 'te-color-name', label);
  name.htmlFor = id;
  const hex = sfEl<HTMLInputElement>('input', 'stp-input sf-hex te-hex');
  hex.type = 'text';
  hex.spellcheck = false;
  hex.setAttribute('aria-label', label + ' as hex');
  pick.addEventListener('input', () => teSet(token, pick.value.toLowerCase(), derive));
  hex.addEventListener('change', () => {
    const v = hex.value.trim();
    const h = /^#?[0-9a-f]{6}$/i.test(v) ? (v[0] === '#' ? v : '#' + v).toLowerCase() : null;
    hex.classList.toggle('is-bad', !h);
    if (h) teSet(token, h, derive);
  });
  const text = sfEl('div', 'te-color-text');
  text.append(name, hex);
  const top = sfEl('div', 'te-color-top');
  top.append(pick, text);
  const warn = sfEl('div', 'te-warn');
  warn.hidden = true;
  wrap.append(top, warn);
  return wrap;
}

function teRange(id: string, token: string, min: number, max: number): HTMLElement {
  const wrap = sfEl('div', 'te-range-wrap');
  const r = sfEl<HTMLInputElement>('input', 'te-range');
  r.type = 'range';
  r.id = id;
  r.min = String(min);
  r.max = String(max);
  r.step = '1';
  const out = sfEl('span', 'te-range-val');
  out.id = id + '-val';
  r.addEventListener('input', () => teSet(token, Number(r.value)));
  wrap.append(r, out);
  return wrap;
}

function teFontSelect(id: string, token: string): HTMLElement {
  const sel = sfSelect(id, Object.keys(themeModel.FONTS).map((k) => [k, themeModel.FONTS[k].label] as [string, string]),
    (v) => teSet(token, v));
  const sample = sfEl('span', 'te-font-sample', 'Aa 123');
  sample.id = id + '-sample';
  sample.setAttribute('aria-hidden', 'true');
  const box = sfEl('div', 'te-font');
  box.append(sel, sample);
  return box;
}

function teControls(): HTMLElement {
  const box = sfEl('div', 'te-controls');
  box.appendChild(teSec('Fonts', 'From the four bundled families. They render from the fonts installed on this computer, with system fallbacks — nothing is downloaded.',
    teField('Text', teFontSelect('te-font-ui', '--font-ui')),
    teField('Figures', teFontSelect('te-font-num', '--font-numeric'))));

  const base = sfEl('div', 'te-color-grid');
  ([['--bg', 'Background'], ['--surface', 'Surface'], ['--text', 'Text'], ['--border', 'Border']] as Array<[string, string]>)
    .forEach(([t, l]) => base.appendChild(teColorField(t, l, teDeriveBase)));
  box.appendChild(teSec('Base palette', 'Card heads, insets and the lighter text and border weights follow from these four.', base));

  const ramp = sfEl('div', 'te-ramp');
  for (let i = 1; i <= 8; i++) ramp.appendChild(teColorField('--chart-' + i, 'Series ' + i));
  const derive = teButton('Derive ramp from accent', 'btn-ghost te-derive', () => {
    if (teDraft) { teDeriveRamp(teDraft.tokens); teRefresh(); }
  }, 'sparkles');
  box.appendChild(teSec('Accent and chart ramp', 'Each colour is checked against the card surface — 3:1 is the floor for chart marks.',
    teColorField('--accent', 'Accent', teDeriveAccent), ramp, derive));

  const rule = sfEl<HTMLButtonElement>('button', 'stp-switch');
  rule.type = 'button';
  rule.id = 'te-rule';
  rule.setAttribute('role', 'switch');
  rule.setAttribute('aria-label', 'Header rule');
  rule.appendChild(sfEl('span', 'stp-switch-thumb'));
  rule.addEventListener('click', () => teSet('--dash-card-rule', teDraft && teDraft.tokens['--dash-card-rule'] === 'off' ? 'on' : 'off'));
  box.appendChild(teSec('Cards', '',
    teField('Border', sfSeg('te-border', [['0', 'None'], ['1', 'Hairline'], ['2', 'Strong']], (v) => teSet('--dash-card-border-w', Number(v)))),
    teField('Shadow', sfSeg('te-shadow', [['none', 'None'], ['sm', 'Soft'], ['md', 'Raised'], ['lg', 'Lifted']], (v) => teSet('--dash-card-shadow', v))),
    teField('Corner radius', teRange('te-radius', '--dash-card-radius', 0, 24)),
    teField('Header rule', rule)));

  box.appendChild(teSec('KPIs', '',
    teField('Value size', teRange('te-kpi-size', '--dash-kpi-size', 18, 48)),
    teField('Label', sfSeg('te-kpi-label', [['below', 'Below the figure'], ['above', 'Above']], (v) => teSet('--dash-kpi-label', v)))));

  box.appendChild(teSec('Density', 'The grid pitch. A card keeps its place — only the spacing moves.',
    teField('Spacing', sfSeg('te-density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], (v) => {
      if (!teDraft) return;
      teDraft.tokens['--dash-gap'] = TE_DENSITY[v][0];
      teSet('--dash-row', TE_DENSITY[v][1]);
    }))));
  return box;
}

// ── The preview: the sample dashboard, at thumbnail size ─────────────────────
// Real dashboard markup (.dash-grid, .dash-card, .dash-metric-value) under the
// real preset classes, so what the theme does here is what hub.css and
// theme-editor.css do to a sheet — not a second drawing of one. The figures
// are schematic placeholders, as in the Style panel's mini-cards: this shows a
// look, never data.
function tePvCard(grid: HTMLElement, title: string, x: number, y: number, w: number, h: number, cls = ''): HTMLElement {
  const card = sfEl('div', 'dash-card ' + cls);
  card.style.gridColumn = (x + 1) + ' / span ' + w;
  card.style.gridRow = (y + 1) + ' / span ' + h;
  const head = sfEl('div', 'dash-card-head');
  head.appendChild(sfEl('div', 'dash-card-title', title));
  const body = sfEl('div', 'dash-card-body');
  card.append(head, body);
  grid.appendChild(card);
  return body;
}

function tePreview(): HTMLElement {
  const pane = sfEl('aside', 'te-preview-pane');
  pane.appendChild(sfEl('div', 'te-preview-label', 'Preview'));
  const frame = sfEl('div', 'te-preview');
  frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', 'The sample dashboard drawn in this theme');
  const sheet = sfEl('div', 'te-preview-sheet dash-theme--clean dash-density--comfortable dash-accent--blue');
  sheet.id = 'te-preview-sheet';
  sheet.appendChild(sfEl('div', 'te-pv-title', 'Retail sales'));
  const grid = sfEl('div', 'dash-grid');
  ([['Revenue', '2.3M'], ['Profit', '286K'], ['Units sold', '38.7K'], ['Orders', '9,994']] as Array<[string, string]>).forEach(([label, v], i) => {
    const body = tePvCard(grid, label, i * 3, 0, 3, 2, 'dash-card--metric');
    body.append(sfEl('div', 'dash-metric-value tnum', v), sfEl('div', 'dash-metric-label', 'Sum of ' + label.toLowerCase()));
  });
  const line = tePvCard(grid, 'Revenue by month', 0, 2, 7, 4);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 50');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'te-pv-line');
  ['4,38 16,30 28,33 40,22 52,26 64,15 76,19 88,9 100,12', '4,44 16,41 28,42 40,36 52,38 64,31 76,33 88,27 100,29'].forEach((pts, i) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    p.setAttribute('points', pts);
    p.style.stroke = 'var(--chart-' + (i + 1) + ')';
    svg.appendChild(p);
  });
  line.appendChild(svg);
  const bars = sfEl('div', 'te-pv-bars');
  [82, 64, 71, 45, 58, 37, 50, 28].forEach((h, i) => {
    const b = sfEl('span', 'te-pv-bar');
    b.style.height = h + '%';
    b.style.background = 'var(--chart-' + (i + 1) + ')';
    bars.appendChild(b);
  });
  tePvCard(grid, 'Revenue by category', 7, 2, 5, 4).appendChild(bars);
  sheet.appendChild(grid);
  frame.appendChild(sheet);
  pane.appendChild(frame);
  pane.appendChild(sfEl('p', 'te-preview-note', 'The sample dashboard, redrawn as you edit — its KPIs and two charts in this theme’s fonts, colours and cards.'));
  return pane;
}

// ── Paint the draft ──────────────────────────────────────────────────────────

function teRefresh(): void {
  const view = document.getElementById('te-editor-view');
  if (!teDraft || !view) return;
  const t = teDraft.tokens;
  const warns = themeModel.themeWarnings(t);
  const byToken = new Map<string, any>(warns.map((w: any) => [w.token, w]));
  view.querySelectorAll('.te-color').forEach((w: HTMLElement) => {
    const token = w.dataset.token || '';
    const v = teHex(t[token], '#000000');
    const pick = w.querySelector('.te-color-input') as HTMLInputElement;
    if (pick.value !== v) pick.value = v;
    const hex = w.querySelector('.te-hex') as HTMLInputElement;
    if (document.activeElement !== hex) { hex.value = v; hex.classList.remove('is-bad'); }
    const hit = byToken.get(token);
    const warn = w.querySelector('.te-warn') as HTMLElement;
    w.classList.toggle('has-warn', !!hit);
    warn.hidden = !hit;
    warn.textContent = '';
    if (hit) warn.append(icon('alert'), sfEl('span', '', hit.message));
  });
  const summary = document.getElementById('te-warn-summary');
  if (summary) {
    summary.hidden = !warns.length;
    summary.textContent = warns.length === 1
      ? 'One colour is under its contrast floor — see the note beside it. You can still save.'
      : warns.length + ' colours are under their contrast floor — see the notes beside them. You can still save.';
  }
  const fontOf = (k: string): string => (themeModel.FONTS[t[k]] ? t[k] : 'hanken');
  ([['te-font-ui', '--font-ui'], ['te-font-num', '--font-numeric']] as Array<[string, string]>).forEach(([id, k]) => {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (sel) sel.value = fontOf(k);
    const sample = document.getElementById(id + '-sample');
    if (sample) sample.style.fontFamily = themeModel.FONTS[fontOf(k)].stack;
  });
  sfSegValue('te-border', String(t['--dash-card-border-w'] ?? 1));
  sfSegValue('te-shadow', t['--dash-card-shadow'] || 'none');
  sfSegValue('te-kpi-label', t['--dash-kpi-label'] || 'below');
  const dens = Object.keys(TE_DENSITY).find((k) => TE_DENSITY[k][0] === t['--dash-gap'] && TE_DENSITY[k][1] === t['--dash-row']);
  sfSegValue('te-density', dens || '');
  ([['te-radius', '--dash-card-radius', 12], ['te-kpi-size', '--dash-kpi-size', 28]] as Array<[string, string, number]>).forEach(([id, k, d]) => {
    const r = document.getElementById(id) as HTMLInputElement | null;
    const v = typeof t[k] === 'number' ? t[k] : d;
    if (r) r.value = String(v);
    const out = document.getElementById(id + '-val');
    if (out) out.textContent = v + 'px';
  });
  const rule = document.getElementById('te-rule');
  if (rule) {
    const on = t['--dash-card-rule'] !== 'off';
    rule.classList.toggle('stp-switch-on', on);
    rule.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  const sheet = document.getElementById('te-preview-sheet');
  if (sheet) applyThemeTokens(sheet, t);
}

// ── Open / close / save ──────────────────────────────────────────────────────

function openThemeEditor(theme: any): void {
  const view = document.getElementById('te-editor-view');
  const list = document.getElementById('te-list-view');
  if (!view || !list || !theme) return;
  teDraft = { id: theme.id, name: theme.name, tokens: { ...theme.tokens } };
  view.innerHTML = '';

  const head = sfEl('div', 'te-editor-head');
  const name = sfEl<HTMLInputElement>('input', 'stp-input te-name');
  name.id = 'te-name';
  name.maxLength = 60;
  name.value = theme.name;
  name.setAttribute('aria-label', 'Theme name');
  name.addEventListener('input', () => { if (teDraft) teDraft.name = name.value; });
  const save = teButton('Save theme', 'btn-primary te-save', () => { void teSave(save); }, 'check');
  head.append(teButton('Themes', 'btn-ghost te-back', closeThemeEditor, 'arrow-left'), name,
    sfEl('span', 'te-spacer'), teButton('Cancel', 'te-cancel', closeThemeEditor), save);

  const summary = sfEl('div', 'te-warn-summary');
  summary.id = 'te-warn-summary';
  summary.setAttribute('role', 'status');
  const body = sfEl('div', 'te-editor-body');
  body.append(teControls(), tePreview());
  view.append(head, summary, body);

  list.hidden = true;
  view.hidden = false;
  teRefresh();
  view.scrollIntoView({ block: 'start' });
  name.focus();
}

function closeThemeEditor(): void {
  teDraft = null;
  const view = document.getElementById('te-editor-view');
  const list = document.getElementById('te-list-view');
  if (view) { view.hidden = true; view.innerHTML = ''; }
  if (list) list.hidden = false;
  paintThemesSection();
}

async function teSave(btn: HTMLButtonElement): Promise<void> {
  if (!teDraft) return;
  btn.disabled = true;
  let res: any = null;
  try { res = await window.hubThemes.save({ id: teDraft.id, name: teDraft.name, tokens: teDraft.tokens }); } catch (_) { res = null; }
  btn.disabled = false;
  if (!res || !res.ok) { showToast((res && res.error) || 'The theme could not be saved.'); return; }
  showToast('Saved “' + res.theme.name + '”');
  closeThemeEditor();
}
