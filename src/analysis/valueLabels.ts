// What a stored column value is CALLED ("EU" -> "Europe"). PURE: no fs, no node imports, because
// the web imports this file too. A column doc without labels reads as [].

import { clip } from '../app/clip';

export interface ValueLabel { value: string; label: string }

export const MAX_VALUE_LABELS = 500;
export const MAX_VALUE_LEN = 256;
export const MAX_LABEL_LEN = 120;

/**
 * Whitelist a stored list. A value is matched against cells exactly, so it is kept verbatim
 * (never trimmed or clipped: one over MAX_VALUE_LEN is dropped) and a blank one is dropped. The
 * label is trimmed and clipped. The first of a repeated value, and the first of a repeated label,
 * wins, so a label names one value and a value has one label.
 */
export function sanitizeValueLabels(raw: unknown): ValueLabel[] {
  const out: ValueLabel[] = [];
  if (!Array.isArray(raw)) return out;
  const values = new Set<string>();
  const labels = new Set<string>();
  for (const r of raw) {
    const o = r as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') continue;
    const value = o.value;
    if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_VALUE_LEN) continue;
    const label = clip(o.label, MAX_LABEL_LEN);
    if (!label || values.has(value) || labels.has(label)) continue;
    values.add(value);
    labels.add(label);
    out.push({ value, label });
    if (out.length >= MAX_VALUE_LABELS) break;
  }
  return out;
}
