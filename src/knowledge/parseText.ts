// What a file is, from its BYTES (never its name), and the .md/.txt reader. PURE.

import { MAX_TEXT_CHARS } from './limits';
import { ParseError } from './parseTypes';

export type Kind = 'pdf' | 'zip' | 'text';

const startsWith = (b: Uint8Array, s: string): boolean => b.length >= s.length && Array.from(s).every((c, i) => b[i] === c.charCodeAt(0));

/** A PDF starts `%PDF-`, a Word file is a zip; anything else is text if it is, or a type we refuse. */
export function kindOf(b: Uint8Array): Kind {
  if (startsWith(b, '%PDF-')) return 'pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6)) return 'zip';
  return 'text';
}

/** Text, newlines as \n, no BOM; THROWS 'type' for a binary (an old .doc's header, a NUL) and 'utf8' for text that is not UTF-8. */
export function readText(b: Uint8Array, markdownName: boolean): { source: 'markdown' | 'text'; text: string } {
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) throw new ParseError('type');
  if (b.includes(0)) throw new ParseError('type');
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);
  } catch {
    throw new ParseError('utf8');
  }
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?/g, '\n');
  if (s.length > MAX_TEXT_CHARS) throw new ParseError('tooLong');
  return { source: markdownName ? 'markdown' : 'text', text: s };
}
