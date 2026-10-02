'use strict';

// Settings → General → FORMATS, and Settings → Appearance → BRANDING.
// Classic global-scope renderer <script>: no import/export. Loads after
// brand.js (wsBranding, wsLogoUrl) and formatBind.js (OrdFormat).
//
// Every control writes through main (formats:set / branding:set /
// branding:pickLogo), which saves, re-sanitizes and PUSHES the result back
// (`prefs:changed` → brand.ts). This file never applies a value itself: what
// the controls show is always what main now holds, repainted on that push —
// so the preview line, the charts and these controls cannot disagree.

const SF_DAYS = [t('settingsFormats.sunday'), t('settingsFormats.monday'), t('settingsFormats.tuesday'), t('settingsFormats.wednesday'), t('settingsFormats.thursday'), t('settingsFormats.friday'), t('settingsFormats.saturday')];
const SF_MONTHS = [t('settingsFormats.january'), t('settingsFormats.february'), t('settingsFormats.march'), t('settingsFormats.april'), 'May', t('settingsFormats.june'), t('settingsFormats.july'),
  t('settingsFormats.august'), t('settingsFormats.september'), t('settingsFormats.october'), t('settingsFormats.november'), t('settingsFormats.december')];
const SF_SWATCHES: Array<[string, string]> = [
  ['#2563eb', t('common.blue')], ['#7c3aed', t('common.violet')], ['#0d9488', t('common.teal')], ['#16a34a', t('common.green')],
  ['#ea580c', t('common.orange')], ['#e11d48', t('common.rose')], ['#db2777', t('settingsFormats.pink')], ['#475569', t('settingsFormats.slate')],
];
const SF_STYLE_PRESETS: Array<[string, string]> = [
  ['auto', t('settingsFormats.auto_follows_the_app')], ['clean', t('common.light')], ['executive', t('common.executive')], ['dense', t('common.dense')], ['dark', t('common.dark')],
];

function sfEl<T extends HTMLElement>(tag: string, cls?: string, text?: string): T {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** One settings row in the panel's own shape: title + description, control on the right. */
function sfRow(title: string, desc: string, ...controls: HTMLElement[]): HTMLElement {
  const row = sfEl('div', 'stp-row');
  const l = sfEl('div', 'stp-rl');
  l.appendChild(sfEl('div', 'stp-rt', title));
  if (desc) l.appendChild(sfEl('div', 'stp-rd', desc));
  const r = sfEl('div', 'stp-rr');
  controls.forEach((c) => r.appendChild(c));
  row.append(l, r);
  return row;
}

function sfSelect(id: string, options: Array<[string, string]>, onChange: (v: string) => void): HTMLSelectElement {
  const sel = sfEl<HTMLSelectElement>('select', 'stp-select');
  sel.id = id;
  options.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function sfSeg(id: string, options: Array<[string, string]>, onPick: (v: string) => void): HTMLElement {
  const seg = sfEl('div', 'stp-seg');
  seg.id = id;
  seg.setAttribute('role', 'radiogroup');
  options.forEach(([v, label]) => {
    const b = sfEl<HTMLButtonElement>('button', 'stp-seg-opt', label);
    b.type = 'button';
    b.dataset.value = v;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => onPick(v));
    seg.appendChild(b);
  });
  return seg;
}

function sfSegValue(id: string, value: string): void {
  document.querySelectorAll('#' + id + ' .stp-seg-opt').forEach((b) => {
    const on = (b as HTMLElement).dataset.value === value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function sfSetFormats(patch: any): void {
  void window.hub.setFormats(patch);
}
function sfSetBranding(patch: any): void {
  void window.hub.setBranding(patch);
}

// ── Formats ──────────────────────────────────────────────────────────────────

function buildFormatsSection(host: HTMLElement): void {
  host.innerHTML = '';
  const head = sfEl('div', 'stp-subhead');
  head.appendChild(sfEl('div', 'stp-subhead-t', t('settingsFormats.formats')));
  head.appendChild(sfEl('div', 'stp-subhead-d',
    t('settingsFormats.how_every_number_and_date_is')));
  host.appendChild(head);

  const preview = sfEl('div', 'sf-preview');
  preview.id = 'stp-fmt-preview';
  host.appendChild(preview);

  const systemLabel = t('settingsFormats.system_default', { p0: (navigator.language ? ' (' + navigator.language + ')' : '') });
  host.appendChild(sfRow(t('settingsFormats.locale'), t('settingsFormats.month_names_and_the_grouping_and'),
    sfSelect('stp-fmt-locale', [['', systemLabel] as [string, string]].concat(OrdFormat.LOCALES.map((l) => [l.id, l.label] as [string, string])),
      (v) => sfSetFormats({ locale: v }))));
  host.appendChild(sfRow(t('settingsFormats.numbers'), t('settingsFormats.grouping_and_decimal_marks'),
    sfSelect('stp-fmt-number', OrdFormat.NUMBER_STYLES.map((s) => [s.id, s.label] as [string, string]), (v) => sfSetFormats({ numberStyle: v }))));
  const cur = sfSelect('stp-fmt-currency', OrdFormat.CURRENCIES.map((c) => [c, c + ' — ' + OrdFormat.currencySymbol(c)] as [string, string]),
    (v) => sfSetFormats({ currency: v }));
  cur.classList.add('sf-select-sm');
  host.appendChild(sfRow(t('common.currency'), t('settingsFormats.for_money_figures_without_a_symbol'),
    cur, sfSeg('stp-fmt-currency-pos', [['before', t('common.before')], ['after', t('common.after')]], (v) => sfSetFormats({ currencyPosition: v }))));
  host.appendChild(sfRow(t('settingsFormats.dates'), '',
    sfSeg('stp-fmt-date', [['short', t('settingsFormats.short')], ['medium', t('common.medium')], ['iso', 'ISO']], (v) => sfSetFormats({ dateFormat: v }))));
  host.appendChild(sfRow(t('settingsFormats.week_starts_on'), t('settingsFormats.for_this_week_last_week_and'),
    sfSelect('stp-fmt-week', SF_DAYS.map((d, i) => [String(i), d] as [string, string]), (v) => sfSetFormats({ weekStart: Number(v) }))));
  host.appendChild(sfRow(t('settingsFormats.fiscal_year_starts_in'), t('settingsFormats.quarters_and_years_in_relative_filters'),
    sfSelect('stp-fmt-fiscal', SF_MONTHS.map((m, i) => [String(i + 1), m] as [string, string]), (v) => sfSetFormats({ fiscalYearStart: Number(v) }))));
  const sw = sfEl<HTMLButtonElement>('button', 'stp-switch');
  sw.type = 'button';
  sw.id = 'stp-fmt-compact';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', t('settingsFormats.compact_numbers'));
  sw.appendChild(sfEl('span', 'stp-switch-thumb'));
  sw.addEventListener('click', () => sfSetFormats({ compact: !OrdFormat.getFormatPrefs().compact }));
  host.appendChild(sfRow(t('settingsFormats.compact_numbers'), t('settingsFormats.big_figures_as_5_2m_rather'), sw));
}

function paintFormatsSection(): void {
  const p = OrdFormat.getFormatPrefs();
  const val = (id: string, v: string): void => {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (el && el.value !== v) el.value = v;
  };
  val('stp-fmt-locale', p.locale || '');
  val('stp-fmt-number', p.numberStyle);
  val('stp-fmt-currency', p.currency);
  val('stp-fmt-week', String(p.weekStart));
  val('stp-fmt-fiscal', String(p.fiscalYearStart));
  sfSegValue('stp-fmt-currency-pos', p.currencyPosition);
  sfSegValue('stp-fmt-date', p.dateFormat);
  const sw = document.getElementById('stp-fmt-compact');
  if (sw) { sw.classList.toggle('stp-switch-on', !!p.compact); sw.setAttribute('aria-checked', String(!!p.compact)); }
  const pv = document.getElementById('stp-fmt-preview');
  if (pv) {
    pv.innerHTML = '';
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const samples: Array<[string, string]> = [
      [t('common.number'), OrdFormat.formatNumber(1234567.891, { maxDecimals: 2 })],
      [t('settingsFormats.figure'), OrdFormat.formatCompact(5194598.73)],
      [t('settingsFormats.money'), OrdFormat.formatCurrency(5194598.73, { compact: true })],
      [t('common.percent'), OrdFormat.formatPercent(0.1321, 1)],
      [t('common.date'), OrdFormat.formatDate(iso)],
    ];
    samples.forEach(([k, v]) => {
      const cell = sfEl('div', 'sf-preview-cell');
      cell.appendChild(sfEl('span', 'sf-preview-k', k));
      cell.appendChild(sfEl('span', 'sf-preview-v tnum', v));
      pv.appendChild(cell);
    });
  }
}

// ── Branding ─────────────────────────────────────────────────────────────────

function buildBrandingSection(host: HTMLElement): void {
  host.innerHTML = '';
  const head = sfEl('div', 'stp-subhead');
  head.appendChild(sfEl('div', 'stp-subhead-t', t('settingsFormats.branding')));
  head.appendChild(sfEl('div', 'stp-subhead-d', t('settingsFormats.your_colour_and_your_mark_on')));
  host.appendChild(head);

  const swatches = sfEl('div', 'sf-swatches');
  swatches.id = 'stp-brand-swatches';
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', t('settingsFormats.accent_colour'));
  SF_SWATCHES.forEach(([hex, name], i) => {
    const b = sfEl<HTMLButtonElement>('button', 'sf-swatch');
    b.type = 'button';
    b.dataset.hex = hex;
    b.title = name;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', name);
    b.style.setProperty('--sw', hex);
    // The first swatch IS the app's own blue — picking it clears the accent.
    b.addEventListener('click', () => sfSetBranding({ accent: i === 0 ? '' : hex }));
    swatches.appendChild(b);
  });
  const hexIn = sfEl<HTMLInputElement>('input', 'stp-input sf-hex');
  hexIn.id = 'stp-brand-hex';
  hexIn.type = 'text';
  hexIn.placeholder = '#2563eb';
  hexIn.spellcheck = false;
  hexIn.setAttribute('aria-label', t('settingsFormats.accent_colour_as_hex'));
  hexIn.addEventListener('change', () => {
    const v = hexIn.value.trim();
    const hex = /^#?[0-9a-f]{6}$/i.test(v) ? (v.startsWith('#') ? v : '#' + v).toLowerCase() : null;
    hexIn.classList.toggle('is-bad', !hex && v !== '');
    if (hex) sfSetBranding({ accent: hex === '#2563eb' ? '' : hex });
  });
  const accentBox = sfEl('div', 'sf-accent');
  accentBox.append(swatches, hexIn);
  host.appendChild(sfRow(t('settingsFormats.accent_colour'), t('settingsFormats.buttons_selections_and_the_chart_palette'), accentBox));

  const logo = sfEl('div', 'sf-logo');
  logo.id = 'stp-brand-logo';
  const frame = sfEl('div', 'sf-logo-frame');
  const pick = sfEl<HTMLButtonElement>('button', 'btn btn-sm', t('settingsFormats.choose_file'));
  pick.type = 'button';
  pick.id = 'stp-brand-logo-pick';
  const clear = sfEl<HTMLButtonElement>('button', 'btn btn-sm btn-ghost', t('common.remove'));
  clear.type = 'button';
  clear.id = 'stp-brand-logo-clear';
  const msg = sfEl('div', 'sf-logo-msg');
  pick.addEventListener('click', async () => {
    msg.textContent = '';
    const res = await window.hub.pickLogo('workspace');
    if (res && res.ok === false && !res.canceled) msg.textContent = res.error || t('common.that_logo_could_not_be_used');
    // A new file of the same kind leaves `branding.logo` unchanged ('png'), so
    // the push alone would keep the old image: reload it here.
    if (res && res.ok) { await brandLoadLogo(); paintBrandingSection(); }
  });
  clear.addEventListener('click', () => { void window.hub.clearLogo('workspace'); });
  const btns = sfEl('div', 'sf-logo-btns');
  btns.append(pick, clear);
  logo.append(frame, btns);
  const logoRow = sfRow(t('common.logo'), t('settingsFormats.png_or_svg_up_to_512'), logo);
  logoRow.appendChild(msg);
  logoRow.classList.add('sf-logo-row');
  host.appendChild(logoRow);

  host.appendChild(sfRow(t('settingsFormats.new_dashboards_start_as'), t('settingsFormats.a_dashboard_s_own_style_panel'),
    sfSelect('stp-brand-style', SF_STYLE_PRESETS, (v) => sfSetBranding({ dashboardStyle: v }))));
}

function paintBrandingSection(): void {
  const accent = (wsBranding && wsBranding.accent) || '';
  document.querySelectorAll('#stp-brand-swatches .sf-swatch').forEach((b, i) => {
    const hex = (b as HTMLElement).dataset.hex || '';
    const on = accent ? hex === accent : i === 0;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  const hexIn = document.getElementById('stp-brand-hex') as HTMLInputElement | null;
  if (hexIn && document.activeElement !== hexIn) { hexIn.value = accent || '#2563eb'; hexIn.classList.remove('is-bad'); }
  const frame = document.querySelector('#stp-brand-logo .sf-logo-frame');
  if (frame) {
    frame.innerHTML = '';
    if (wsLogoUrl) {
      const img = document.createElement('img');
      img.src = wsLogoUrl;
      img.alt = t('settingsFormats.workspace_logo');
      frame.appendChild(img);
    } else {
      frame.appendChild(icon('layout-dashboard', 18));
      frame.appendChild(sfEl('span', 'sf-logo-none', t('common.no_logo')));
    }
  }
  const clear = document.getElementById('stp-brand-logo-clear') as HTMLButtonElement | null;
  if (clear) clear.hidden = !wsLogoUrl;
  const st = document.getElementById('stp-brand-style') as HTMLSelectElement | null;
  if (st) st.value = (wsBranding && wsBranding.dashboardStyle) || 'auto';
}

(function initSettingsFormats(): void {
  const f = document.getElementById('stp-formats');
  const b = document.getElementById('stp-branding');
  if (f) { buildFormatsSection(f); buildCalendarGroup(f); }
  if (b) buildBrandingSection(b);
  const paint = (): void => { paintFormatsSection(); paintBrandingSection(); paintCalendarGroup(); };
  paint();
  // brand.ts sends this after every push from main — and a theme flip, which
  // is harmless to repaint on.
  document.addEventListener('themechange', paint);
})();
