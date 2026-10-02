// Dragging OUT of the app: the file a drag carries, written where the OS can
// copy it from. Pure helpers plus fs — no Electron, so the tests run under node.
//
// Each drag writes into its own `<dir>/<uuid>/` so the file the user sees keeps
// a clean name ("Sales by region.png") and two drags of same-named things never
// overwrite a file the OS may still be copying. The whole folder is cleared on
// the next launch (src/ipc/dragDrop.ts).
//
// The CSV is the one CSV the app writes. RFC 4180 (CRLF, every field that needs
// it quoted with "" escaping) and FORMULA-INJECTION SAFE: a TEXT cell starting
// with = + - @ (or tab / CR) gets a leading ' so a spreadsheet opening the file
// shows it as text instead of running it. Numbers are never prefixed — -12 is a
// number, not a formula.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

type Cell = string | number | null | undefined;

const INJECTION = /^[=+\-@\t\r]/;

export function csvField(v: Cell): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  if (typeof v !== 'number' && INJECTION.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** A whole table as CSV text: header row then data rows, CRLF-terminated. */
export function csvOf(columns: string[], rows: Cell[][]): string {
  const out: string[] = [columns.map(csvField).join(',')];
  for (const r of rows) out.push(columns.map((_c, i) => csvField(r[i])).join(','));
  return out.join('\r\n') + '\r\n';
}

/** A name safe as a file name on every OS: no separators, reserved or control characters, no leading dot. */
export function safeFileName(name: unknown, fallback: string): string {
  const s = Array.from(String(name ?? ''))
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || '<>:"/\\|?*'.includes(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 80)
    .trim();
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s) || !s ? fallback : s;
}

/** Write `data` as `<dir>/<uuid>/<safe name>.<ext>`, atomically; returns the path. */
export async function writeDragFile(dir: string, name: unknown, ext: 'png' | 'csv', data: Buffer | string): Promise<string> {
  const sub = path.join(dir, randomUUID());
  await fs.promises.mkdir(sub, { recursive: true });
  const file = path.join(sub, safeFileName(name, ext === 'png' ? 'Chart' : 'Data') + '.' + ext);
  const tmp = path.join(sub, '.' + randomUUID() + '.tmp');
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
  return file;
}

/** Remove everything a previous session's drags left behind. */
export function clearDragDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* nothing to clear, or in use — the next launch tries again */ }
}

/** A `data:image/png;base64,…` URL as PNG bytes, or null when it is not a PNG. */
export function pngFromDataUrl(url: unknown, maxBytes: number): Buffer | null {
  if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,')) return null;
  const b64 = url.slice('data:image/png;base64,'.length);
  if (b64.length > Math.ceil(maxBytes / 3) * 4) return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? buf : null;
}
