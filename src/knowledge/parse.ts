// One file's bytes to its text (docs/knowledge-docs/00-design.md, "Reading files"). The type comes from the BYTES,
// never the name; the name only says whether a text file is Markdown. THROWS ParseError. Runs in the worker thread
// (./parseWorker), started by ./readDocument; tests may call it in process.

import { readDocx } from './docx';
import { readPdf } from './pdf';
import { kindOf, readText } from './parseText';
import { ParseError, type Parsed } from './parseTypes';
import { MAX_TEXT_CHARS } from './limits';

export async function parseBytes(bytes: Uint8Array, fileName = ''): Promise<Parsed> {
  const kind = kindOf(bytes);
  if (kind === 'pdf') return { source: 'pdf', text: await readPdf(bytes) };
  if (kind === 'zip') return { source: 'docx', text: await readDocx(bytes) };
  const { source, text } = readText(bytes, /\.(md|markdown)$/i.test(fileName));
  if (!text.trim()) throw new ParseError('noText');
  if (text.length > MAX_TEXT_CHARS) throw new ParseError('tooLong');
  return { source, text };
}
