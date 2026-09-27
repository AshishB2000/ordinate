'use strict';

// Workspace FORMATS and BRANDING, live in the renderer. Classic global-scope
// <script>: no import/export. Loads after chartPalette.js (applyBrandTokens)
// and formatBind.js (OrdFormat).
//
// On load, and whenever Settings changes them (main pushes `prefs:changed`):
//   · formats → OrdFormat.setFormatPrefs, so every axis, tooltip, card and
//     table formats the new way, and wsFormats, so a fiscal period is named;
//   · the accent → --brand-* tokens on <html> (theme.css reads them);
//   · the logo → kept as a data: URL, and as a PNG for the report writers,
//     which cannot embed an SVG.
// Then one `themechange` event — the same event a light/dark flip sends — and
// every chart surface redraws itself with the new tokens and numbers.

let wsBranding: any = { accent: '', logo: '', dashboardStyle: 'auto' };
/** The workspace logo as a data: URL (PNG or SVG), or null. */
let wsLogoUrl: string | null = null;
/** The same logo rasterised to PNG — what a PDF, PPTX or DOCX can embed. */
let wsLogoPng: string | null = null;

/** Draw an SVG (or any image) data: URL onto a canvas and read back a PNG. */
function brandRasterize(dataUrl: string, width = 480): Promise<string | null> {
  if (/^data:image\/png/.test(dataUrl)) return Promise.resolve(dataUrl);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : 0.3;
      const c = document.createElement('canvas');
      c.width = width;
      c.height = Math.max(1, Math.round(width * ratio));
      const ctx = c.getContext('2d');
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      try { resolve(c.toDataURL('image/png')); } catch (_) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function brandLoadLogo(): Promise<void> {
  let res: any = null;
  try { res = wsBranding.logo ? await window.hub.getLogo('workspace') : null; } catch (_) { res = null; }
  wsLogoUrl = res && res.dataUrl ? String(res.dataUrl) : null;
  wsLogoPng = wsLogoUrl ? await brandRasterize(wsLogoUrl) : null;
}

/** Apply `{ formats, branding }` from main. `redraw` repaints what is on screen. */
async function applyWorkspacePrefs(p: any, redraw: boolean): Promise<void> {
  if (!p) return;
  if (p.formats) {
    OrdFormat.setFormatPrefs(p.formats);
    wsFormats = p.formats;
  }
  if (p.branding) {
    const logoChanged = p.branding.logo !== wsBranding.logo;
    wsBranding = p.branding;
    applyBrandTokens(document.documentElement, wsBranding.accent || '');
    if (logoChanged || (wsBranding.logo && !wsLogoUrl)) await brandLoadLogo();
  }
  if (redraw) document.dispatchEvent(new CustomEvent('themechange', { detail: { reason: 'prefs' } }));
}

/**
 * The logo a dashboard's own surfaces carry — Present mode's corner, its
 * export header, its report covers: its Style panel says Workspace (the
 * default), None, or its own uploaded mark. `png` asks for the raster form.
 */
async function dashLogoFor(analysis: any, png = false): Promise<string | null> {
  const style = analysis && analysis.style ? analysis.style : {};
  if (style.logo === 'none') return null;
  if (style.logo === 'custom' && analysis && analysis.id) {
    let res: any = null;
    try { res = await window.hub.getLogo(String(analysis.id)); } catch (_) { res = null; }
    const url = res && res.dataUrl ? String(res.dataUrl) : null;
    return url && png ? brandRasterize(url) : url;
  }
  return png ? wsLogoPng : wsLogoUrl;
}

/**
 * The accent ramp an exported file writes out as literal colours when a brand
 * hex drives the sheet — the dashboard's own, else the workspace's on a blue
 * sheet (the one accent class that reads --brand-*). Null means the named
 * accent's own ramp applies, which main already carries.
 */
function brandExportRamp(style: any, dark: boolean): any {
  const hex = style.accentHex || (style.accent === 'blue' ? wsBranding.accent : '');
  const t = hex ? brandTokens(hex) : null;
  if (!t) return null;
  const p = dark ? '--brand-dk-' : '--brand-';
  const v = dark ? t.dark : t.light;
  return {
    accent: v[p + 'accent'], accent2: v[p + 'accent-2'], soft: v[p + 'accent-soft'], line: v[p + 'accent-line'],
    chart: CHART_PALETTE.map((_c, i) => v[p + 'chart-' + (i + 1)]),
  };
}

(async function initWorkspacePrefs(): Promise<void> {
  if (!window.hub || typeof window.hub.getPrefs !== 'function') return;
  try { await applyWorkspacePrefs(await window.hub.getPrefs(), true); } catch (_) { /* defaults stand */ }
  window.hub.onPrefsChanged((p: any) => { void applyWorkspacePrefs(p, true); });
})();
