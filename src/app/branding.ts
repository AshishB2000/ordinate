// WORKSPACE BRANDING — the accent colour, the logo and the style new
// dashboards start in. MAIN PROCESS.
//
// The settings are three small values on config.json (sanitized below). The
// LOGO is a file — userData/branding/logo.png|svg — because it is bytes, can
// be half a megabyte, and has no business inside a JSON the whole app re-reads.
// A dashboard can carry its own logo (Style panel → Logo → Custom), stored
// beside it as branding/dash-<analysisId>.png|svg.
//
// Every logo is VALIDATED before it is written: a PNG by its eight signature
// bytes, an SVG by being text that is an <svg> document with no script, no
// event handler and no external reference. It is only ever shown through
// <img> or embedded as a data: URL, where an SVG cannot run anything — the
// checks are defence in depth for the day a caller uses it some other way.
// Writes are atomic (temp sibling, then rename), like every store here.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type DashStylePreset = 'auto' | 'clean' | 'executive' | 'dense' | 'dark';
export const DASH_STYLE_PRESET_IDS: readonly DashStylePreset[] = ['auto', 'clean', 'executive', 'dense', 'dark'];

export interface Branding {
  /** '#rrggbb', or '' for the app's own blue. */
  accent: string;
  /** Which logo file exists, or '' for none. */
  logo: '' | 'png' | 'svg';
  /** The style a NEW dashboard starts in. */
  dashboardStyle: DashStylePreset;
}

export const BRANDING_DEFAULTS: Branding = { accent: '', logo: '', dashboardStyle: 'auto' };

/** The eight accent swatches Settings offers, in order. The first is the app's own. */
export const ACCENT_SWATCHES: readonly string[] = [
  '#2563eb', '#7c3aed', '#0d9488', '#16a34a', '#ea580c', '#e11d48', '#db2777', '#475569',
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function sanitizeHex(v: unknown): string {
  return typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : '';
}

export function sanitizeBranding(raw: unknown): Branding {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    accent: sanitizeHex(o.accent),
    logo: o.logo === 'png' || o.logo === 'svg' ? o.logo : '',
    dashboardStyle: (DASH_STYLE_PRESET_IDS as readonly string[]).includes(String(o.dashboardStyle))
      ? (o.dashboardStyle as DashStylePreset) : 'auto',
  };
}

// ── Logo validation ─────────────────────────────────────────────────────────

/** Half a megabyte: a logo is a mark on a cover, not a photograph. */
export const LOGO_MAX_BYTES = 512 * 1024;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type LogoCheck = { ok: true; kind: 'png' | 'svg' } | { ok: false; error: string };

/** Is this a logo we will keep? PNG by signature, SVG by content — never by file name. */
export function validateLogo(buf: Buffer | null | undefined): LogoCheck {
  if (!buf || !buf.length) return { ok: false, error: 'That file is empty.' };
  if (buf.length > LOGO_MAX_BYTES) {
    return { ok: false, error: `That logo is ${(buf.length / 1024).toFixed(0)} KB — the limit is ${LOGO_MAX_BYTES / 1024} KB.` };
  }
  if (PNG_SIG.every((b, i) => buf[i] === b)) return { ok: true, kind: 'png' };
  const text = buf.toString('utf8');
  const head = text.replace(/^﻿/, '').replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trimStart();
  if (/^<svg[\s>]/i.test(head) || /^<!doctype svg/i.test(head)) {
    if (/<script/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text) || /<foreignObject/i.test(text)) {
      return { ok: false, error: 'That SVG contains script — use a plain SVG or a PNG.' };
    }
    if (/(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|file:)/i.test(text)) {
      return { ok: false, error: 'That SVG loads something from elsewhere — use a self-contained SVG or a PNG.' };
    }
    return { ok: true, kind: 'svg' };
  }
  return { ok: false, error: 'Use a PNG or an SVG file.' };
}

// ── Logo storage ────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `logo` for the workspace, `dash-<uuid>` for one dashboard's own. */
function logoBase(scope: string): string | null {
  if (scope === 'workspace') return 'logo';
  return UUID_RE.test(scope) ? 'dash-' + scope.toLowerCase() : null;
}

function brandingDir(userData: string): string {
  return path.join(userData, 'branding');
}

/** Validate and store; replaces whichever kind was there. */
export async function saveLogo(userData: string, scope: string, buf: Buffer): Promise<LogoCheck> {
  const base = logoBase(scope);
  if (!base) return { ok: false, error: 'Unknown logo scope.' };
  const check = validateLogo(buf);
  if (!check.ok) return check;
  const dir = brandingDir(userData);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${base}.${check.kind}`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.rename(tmp, file);
  const other = path.join(dir, `${base}.${check.kind === 'png' ? 'svg' : 'png'}`);
  await fs.promises.rm(other, { force: true });
  return check;
}

export async function removeLogo(userData: string, scope: string): Promise<void> {
  const base = logoBase(scope);
  if (!base) return;
  for (const ext of ['png', 'svg']) {
    await fs.promises.rm(path.join(brandingDir(userData), `${base}.${ext}`), { force: true });
  }
}

/** The stored logo as a data: URL — what an <img>, a report and an export embed — or null. */
export async function readLogoDataUrl(userData: string, scope: string): Promise<string | null> {
  const base = logoBase(scope);
  if (!base) return null;
  for (const [ext, mime] of [['png', 'image/png'], ['svg', 'image/svg+xml']] as const) {
    try {
      const buf = await fs.promises.readFile(path.join(brandingDir(userData), `${base}.${ext}`));
      if (validateLogo(buf).ok) return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (_) { /* not this kind */ }
  }
  return null;
}
