// How a CELL or an app SENTENCE is printed into a model prompt — PURE.
//
// Anyone who can write a row writes cells, so a cell must never open a line of
// its own in a prompt, where it could pose as an instruction (D3,
// docs/semantic-layer/03-ai.md). A cell goes through `cell`/`quoted`:
// JSON-escaped, U+2028/U+2029 too, cut at PROMPT_VALUE_CHARS. An app sentence
// that embeds one goes through `oneLine`: the person reads the same words, the
// model reads them on one line.

import { WITHHELD } from './columnNotes';

/** A value is cut to this many characters in a prompt. */
export const PROMPT_VALUE_CHARS = 60;

const escapeSeparators = (json: string): string => json.replace(/[\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`);

/** A value as a prompt shows it: cut (never inside a surrogate pair), JSON-quoted, line separators escaped too. */
export function quoted(v: string): string {
  let cut = v;
  if (v.length > PROMPT_VALUE_CHARS) {
    let end = PROMPT_VALUE_CHARS - 1;
    const c = v.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    cut = `${v.slice(0, end)}…`;
  }
  return escapeSeparators(JSON.stringify(cut));
}

/**
 * One cell: a string quoted, a finite number as it is ('007' stays "007", 7
 * stays 7), empty for null. The withheld marker is the app's, not a cell, so it
 * prints bare, as it always has.
 */
export function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return v === WITHHELD ? WITHHELD : quoted(String(v));
}

/** An app sentence on one line (JS `\s` covers U+2028/U+2029). */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** JSON for a prompt, with the line separators JSON.stringify leaves raw escaped. */
export function promptJson(v: unknown): string {
  return escapeSeparators(JSON.stringify(v));
}
