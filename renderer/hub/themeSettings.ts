'use strict';

// Settings → Appearance → THEMES — the list: the built-in presets as read-only
// entries, the user's own themes with Edit / Duplicate / Delete, and the
// workspace default. Classic global-scope <script>: no import/export. Loads
// after settingsFormats.js (sfEl / sfRow — the panel's own row shape), after
// dashStyle.js (the preset vocabulary) and after themeApply.js (wsThemes,
// applyThemeTokens). The editor itself is themeEditor.ts.
//
// Every write goes through main (window.hubThemes), which validates, saves and
// PUSHES the new state back; this list repaints on that push, never from its
// own guess — the same discipline as settingsFormats.ts.

/** The built-ins offered here, in the Style panel's own order. */
const TE_BUILTINS = ['auto', 'clean', 'executive', 'dark', 'dense'];

/** Theme id being confirmed for deletion, or ''. */
let teConfirmId = '';

// ── Reading a built-in ───────────────────────────────────────────────────────
// A built-in preset IS its hub.css blocks, so a duplicate is READ off them —
// computed off a probe carrying the preset's classes — rather than transcribed
// into a second table that would drift. The card metrics come off a real
// .dash-card in the probe, the way dashShare measures an export. The probe has
// to be in the document: a detached element computes no custom properties.
function teBuiltinTokens(preset: string): any {
  const probe = document.createElement('div');
  probe.className = 'te-probe';
  dashStyleClassList(DASH_STYLE_PRESETS[preset]).forEach((c) => probe.classList.add(c));
  const card = document.createElement('div');
  card.className = 'dash-card dash-card--metric';
  const body = document.createElement('div');
  body.className = 'dash-card-body';
  const value = document.createElement('div');
  value.className = 'dash-metric-value';
  value.textContent = '0';
  body.appendChild(value);
  card.appendChild(body);
  probe.appendChild(card);
  document.body.appendChild(probe);
  try {
    const cs = getComputedStyle(probe);
    const raw: any = {};
    themeModel.AXIS_TOKENS.forEach((t: string) => { raw[t] = cs.getPropertyValue(t).trim(); });
    const serif = /serif/.test(raw['--font-numeric']) && !/sans-serif\s*$/.test(raw['--font-numeric']);
    raw['--font-ui'] = 'hanken';
    raw['--font-numeric'] = serif ? 'source-serif' : 'hanken';
    const cc = getComputedStyle(card);
    raw['--dash-card-border-w'] = parseFloat(cc.borderTopWidth) || 0;
    raw['--dash-card-radius'] = parseFloat(cc.borderTopLeftRadius) || 0;
    raw['--dash-card-shadow'] = cc.boxShadow && cc.boxShadow !== 'none' ? 'md' : 'none';
    raw['--dash-card-rule'] = 'on';
    raw['--dash-kpi-size'] = parseFloat(getComputedStyle(value).fontSize) || 28;
    raw['--dash-kpi-label'] = 'below';
    return themeModel.sanitizeTokens(raw);
  } finally {
    probe.remove();
  }
}

/** A name nobody in the list has yet: "Copy of Light", "Copy of Light 2", … */
function teUniqueName(base: string): string {
  let name = base;
  for (let i = 2; wsThemes.themes.some((t) => t.name === name); i++) name = base + ' ' + i;
  return name;
}

async function teDuplicate(name: string, tokens: any): Promise<void> {
  const res = await window.hubThemes.save({ name: teUniqueName('Copy of ' + name), tokens });
  if (!res || !res.ok) showToast((res && res.error) || 'The theme could not be saved.');
  else showToast('Duplicated as “' + res.theme.name + '”');
}

// ── One row ──────────────────────────────────────────────────────────────────

/** A thumbnail: the page, one card, four bars in the ramp — painted by the theme's own tokens. */
function teThumb(apply: (el: HTMLElement) => void): HTMLElement {
  const thumb = sfEl('span', 'te-thumb');
  thumb.setAttribute('aria-hidden', 'true');
  const card = sfEl('span', 'te-thumb-card');
  for (let i = 1; i <= 4; i++) {
    const bar = sfEl('span', 'te-thumb-bar');
    bar.style.background = 'var(--chart-' + i + ')';
    bar.style.height = [55, 90, 40, 70][i - 1] + '%';
    card.appendChild(bar);
  }
  thumb.appendChild(card);
  apply(thumb);
  return thumb;
}

function teButton(label: string, cls: string, onClick: () => void, iconName?: string): HTMLButtonElement {
  const b = sfEl<HTMLButtonElement>('button', 'btn btn-sm ' + cls);
  b.type = 'button';
  if (iconName) b.appendChild(icon(iconName));
  b.appendChild(document.createTextNode(label));
  b.addEventListener('click', onClick);
  return b;
}

function teRow(opts: { key: string; name: string; note: string; badge?: string; thumb: HTMLElement; actions: HTMLElement[] }): HTMLElement {
  const row = sfEl('div', 'te-row');
  row.dataset.key = opts.key;
  const main = sfEl('div', 'te-row-main');
  const title = sfEl('div', 'te-row-name', opts.name);
  if (opts.badge) title.appendChild(sfEl('span', 'te-badge', opts.badge));
  main.append(title, sfEl('div', 'te-row-note', opts.note));
  const actions = sfEl('div', 'te-row-actions');
  opts.actions.forEach((a) => actions.appendChild(a));
  row.append(opts.thumb, main, actions);
  return row;
}

/** "Inter · Source Serif figures · 2 contrast warnings" — what a theme is, at a glance. */
function teSummary(tokens: any): string {
  const font = (k: string): string => (themeModel.FONTS[tokens[k]] || themeModel.FONTS.hanken).label;
  const parts = [font('--font-ui')];
  if (tokens['--font-numeric'] && tokens['--font-numeric'] !== tokens['--font-ui']) parts.push(font('--font-numeric') + ' figures');
  const n = themeModel.themeWarnings(tokens).length;
  parts.push(n ? n + ' contrast warning' + (n === 1 ? '' : 's') : 'contrast OK');
  return parts.join(' · ');
}

function teUserRow(t: any): HTMLElement {
  if (teConfirmId === t.id) {
    const row = sfEl('div', 'te-row te-row--confirm');
    row.dataset.key = t.id;
    row.setAttribute('role', 'alert');
    const msg = sfEl('div', 'te-row-main');
    msg.append(sfEl('div', 'te-row-name', 'Delete “' + t.name + '”?'),
      sfEl('div', 'te-row-note', 'Dashboards that use it fall back to the workspace default, then to their own style.'));
    const actions = sfEl('div', 'te-row-actions');
    actions.append(
      teButton('Cancel', 'te-cancel-delete', () => { teConfirmId = ''; paintThemesSection(); }),
      teButton('Delete', 'btn-danger te-confirm-delete', async () => {
        teConfirmId = '';
        const res = await window.hubThemes.remove(t.id);
        if (!res || !res.ok) { showToast('That theme could not be deleted.'); paintThemesSection(); }
      }, 'trash'),
    );
    row.append(msg, actions);
    return row;
  }
  return teRow({
    key: t.id, name: t.name, note: teSummary(t.tokens),
    badge: t.id === wsThemes.defaultId ? 'Workspace default' : '',
    thumb: teThumb((el) => applyThemeTokens(el, t.tokens)),
    actions: [
      teButton('Edit', 'te-edit', () => openThemeEditor(t), 'pencil'),
      teButton('Duplicate', 'btn-ghost te-duplicate', () => { void teDuplicate(t.name, t.tokens); }, 'copy'),
      teButton('Delete', 'btn-ghost te-delete', () => { teConfirmId = t.id; paintThemesSection(); }, 'trash'),
    ],
  });
}

// ── The section ──────────────────────────────────────────────────────────────

function buildThemesSection(host: HTMLElement): void {
  host.innerHTML = '';
  const head = sfEl('div', 'stp-subhead');
  head.appendChild(sfEl('div', 'stp-subhead-t', 'Themes'));
  head.appendChild(sfEl('div', 'stp-subhead-d',
    'Colours, fonts and card style for dashboards. Apply one to a dashboard from its Style panel, or make it the workspace default. Exports and reports carry it.'));
  host.appendChild(head);

  const list = sfEl('div', 'te-view');
  list.id = 'te-list-view';
  const def = sfEl<HTMLSelectElement>('select', 'stp-select');
  def.id = 'te-default';
  def.setAttribute('aria-label', 'Workspace theme');
  def.addEventListener('change', async () => {
    const res = await window.hubThemes.setDefault(def.value);
    if (!res || !res.ok) { showToast('That theme could not be made the default.'); paintThemesSection(); }
  });
  list.appendChild(sfRow('Workspace theme', 'Every dashboard wears it unless its own Style panel picks another.', def));

  const group = (id: string, title: string): HTMLElement => {
    const g = sfEl('div', 'te-group');
    const h = sfEl('div', 'te-group-h', title);
    const count = sfEl('span', 'te-count');
    count.id = id + '-count';
    h.appendChild(count);
    const l = sfEl('div', 'te-list');
    l.id = id;
    g.append(h, l);
    list.appendChild(g);
    return l;
  };
  // Yours first: they are what this section is for; the built-ins are where one starts.
  group('te-user-list', 'Your themes');
  group('te-builtin-list', 'Built-in');
  host.appendChild(list);

  const editor = sfEl('div', 'te-view');
  editor.id = 'te-editor-view';
  editor.hidden = true;
  host.appendChild(editor);
}

function paintThemesSection(): void {
  const def = document.getElementById('te-default') as HTMLSelectElement | null;
  if (def) {
    def.innerHTML = '';
    const opts: Array<[string, string]> = [['', 'None — each dashboard’s own style']];
    wsThemes.themes.forEach((t) => opts.push([t.id, t.name]));
    opts.forEach(([v, text]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = text;
      def.appendChild(o);
    });
    def.value = wsThemes.defaultId || '';
    def.disabled = wsThemes.themes.length === 0;
  }

  const builtins = document.getElementById('te-builtin-list');
  if (builtins && !builtins.childElementCount) {
    // Built-ins never change while the app runs; built once.
    TE_BUILTINS.forEach((p) => builtins.appendChild(teRow({
      key: p, name: DASH_STYLE_LABELS[p], note: DASH_STYLE_NOTES[p], badge: 'Read-only',
      thumb: teThumb((el) => dashStyleClassList(DASH_STYLE_PRESETS[p]).forEach((c) => el.classList.add(c))),
      actions: [teButton('Duplicate', 'te-duplicate', () => { void teDuplicate(DASH_STYLE_LABELS[p], teBuiltinTokens(p)); }, 'copy')],
    })));
    const c = document.getElementById('te-builtin-list-count');
    if (c) c.textContent = String(TE_BUILTINS.length);
  }

  const users = document.getElementById('te-user-list');
  if (!users) return;
  users.innerHTML = '';
  const c = document.getElementById('te-user-list-count');
  if (c) c.textContent = String(wsThemes.themes.length);
  if (!wsThemes.themes.length) {
    const empty = sfEl('div', 'te-empty');
    const ic = sfEl('span', 'te-empty-icon');
    ic.appendChild(icon('layers', 20));
    const text = sfEl('div', 'te-empty-body');
    text.append(sfEl('div', 'te-empty-t', 'No themes of your own yet'),
      sfEl('div', 'te-empty-d', 'Duplicate a built-in below to start one — its palette, chart colours, fonts, cards and density are all yours to change.'));
    empty.append(ic, text);
    users.appendChild(empty);
    return;
  }
  wsThemes.themes.forEach((t) => users.appendChild(teUserRow(t)));
}

(function initThemesSection(): void {
  const pane = document.querySelector('.settings-pane[data-cat="appearance"]');
  if (!pane || !window.hubThemes) return;
  const host = sfEl('div', 'stp-group te-section');
  host.id = 'stp-themes';
  pane.appendChild(host);
  buildThemesSection(host);
  paintThemesSection();
  document.addEventListener('ws-themes-changed', paintThemesSection);
})();
