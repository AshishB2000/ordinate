'use strict';

// Workspace THEMES, live in the renderer — one job: know which theme a sheet
// resolves to and put its tokens on that sheet. Classic global-scope <script>:
// no import/export. Loads after themeModel.js (the pure model) and after
// dashStyle.js, whose applyDashStyleTo calls applyDashTheme — so every surface
// that styles a sheet (the editor, Present, an export probe, a capture holder)
// gets the theme through the one path it already uses for presets.
//
// Applying a theme = setting its validated tokens as inline custom properties
// on the sheet element (el.style.setProperty — CSP-fine, unlike an inline
// style= attribute), the way applyBrandTokens sets brand tokens. Inline beats
// the preset classes' rules, so a theme wins over the preset under it without a
// cascade fight, and clearing it (removing the properties) hands the sheet back
// to its preset: the built-in step of the resolution order.

/** Every user theme and the workspace default — main's state, pushed on change. */
let wsThemes: { defaultId: string; themes: any[] } = { defaultId: '', themes: [] };

/** Dashboard's own theme → workspace default → built-in (null). */
function dashThemeResolve(style: any): { theme: any; source: string } {
  return themeModel.resolveTheme(style && style.themeId, wsThemes.defaultId, wsThemes.themes);
}

/** Set a token map on an element, or clear every theme token with `null`. */
function applyThemeTokens(el: HTMLElement, tokens: any): void {
  themeModel.ALL_TOKENS.forEach((n: string) => el.style.removeProperty(n));
  el.style.removeProperty('color-scheme');
  el.classList.toggle('dash-themed', !!tokens);
  if (!tokens) return;
  themeModel.themeCssVars(tokens).forEach(([k, v]: [string, string]) => el.style.setProperty(k, v));
  // Not a custom property, so no token can carry it: without it a dark theme
  // on a light app draws white native <select>s and date pickers on dark cards.
  if (tokens['--bg']) el.style.setProperty('color-scheme', themeModel.isDark(tokens['--bg']) ? 'dark' : 'light');
}

/** The theme a dashboard style resolves to, on `el` (called by applyDashStyleTo). */
function applyDashTheme(el: HTMLElement | null, style: any): void {
  if (!el) return;
  const r = dashThemeResolve(style);
  applyThemeTokens(el, r.theme ? r.theme.tokens : null);
}

/** What an exported file carries: the resolved theme's name and tokens, or null. Main re-validates. */
function dashThemeExport(style: any): any {
  const r = dashThemeResolve(style);
  return r.theme ? { name: r.theme.name, tokens: r.theme.tokens } : null;
}

function wsThemeById(id: string): any {
  return wsThemes.themes.find((t) => t && t.id === id) || null;
}

function wsThemesSet(state: any): void {
  wsThemes = {
    defaultId: (state && state.defaultId) || '',
    themes: state && Array.isArray(state.themes) ? state.themes : [],
  };
  // The open sheet repaints under the edited theme — and redraws, because
  // Chart.js reads its colours once, at construction.
  if (dashCurrent) {
    syncDashStyle();
    renderDashGrid();
  }
  document.dispatchEvent(new CustomEvent('ws-themes-changed'));
}

// ── The dashboard Style panel's Theme row ────────────────────────────────────
// `state.themeId` is the modal's working copy ('' = follow the workspace,
// 'none' = the preset only, or a theme id); `onChange` previews it live, the
// way the accent swatches do. Apply/Cancel belong to the modal.
function buildDashThemeField(state: { themeId: string }, onChange: () => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dash-style-brand';
  const row = document.createElement('div');
  row.className = 'dash-style-field';
  const label = document.createElement('label');
  label.className = 'dash-style-label';
  label.textContent = t('common.theme');
  label.htmlFor = 'dash-style-theme';
  const sel = document.createElement('select');
  sel.className = 'stp-select te-style-select';
  sel.id = 'dash-style-theme';
  const def = wsThemeById(wsThemes.defaultId);
  const opts: Array<[string, string]> = [
    ['', def ? t('themeApply.workspace_default', { name: def.name }) : t('themeApply.workspace_default_none_set')],
    ['none', t('themeApply.none_the_style_above_only')],
  ];
  wsThemes.themes.forEach((t) => opts.push([t.id, t.name]));
  opts.forEach(([v, text]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = text;
    sel.appendChild(o);
  });
  // A theme deleted since this dashboard picked it is not an option any more;
  // the sheet already falls through, so the control says what it falls to.
  sel.value = state.themeId && (state.themeId === 'none' || wsThemeById(state.themeId)) ? state.themeId : '';
  sel.addEventListener('change', () => { state.themeId = sel.value; onChange(); });
  row.append(label, sel);
  wrap.appendChild(row);
  const hint = document.createElement('p');
  hint.className = 'te-style-hint';
  hint.textContent = wsThemes.themes.length
    ? t('themeApply.a_theme_sets_colours_fonts_and')
    : t('themeApply.no_themes_yet_make_one_in');
  wrap.appendChild(hint);
  return wrap;
}

(async function initWorkspaceThemes(): Promise<void> {
  if (!window.hubThemes) return;
  window.hubThemes.onChanged(wsThemesSet);
  try { wsThemesSet(await window.hubThemes.list()); } catch (_) { /* no themes: every sheet keeps its preset */ }
})();
