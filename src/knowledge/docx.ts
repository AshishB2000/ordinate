// A Word file's text (docs/knowledge-docs/00-design.md, "Reading files"): jszip opens the zip, saxes reads
// word/document.xml. Headings become Markdown headings, a table row becomes `a | b | c`. Images, comments and
// tracked deletions are left out. Runs inside the worker thread (./parseWorker), never on the request thread.

import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { MAX_DOCX_XML_BYTES, MAX_TEXT_CHARS } from './limits';
import { ParseError } from './parseTypes';

const ENTRY = 'word/document.xml';
/** The declared inflated size of an entry. jszip keeps it on the entry's private data; a lie is caught by jszip itself (size mismatch). */
// any: jszip's entry internals have no public type
const declaredSize = (entry: any): number => Number(entry?._data?.uncompressedSize);

/** Is `b` a zip holding word/document.xml? THROWS 'type' for any other zip (xlsx, pptx) or a broken one. */
async function open(b: Uint8Array): Promise<JSZip.JSZipObject> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(b);
  } catch {
    throw new ParseError('type');
  }
  const entry = zip.file(ENTRY);
  if (!entry) throw new ParseError('type');
  return entry;
}

/** The text of a .docx, or THROWS: 'zipBomb' before anything is inflated, 'type', 'noText', 'tooLong', 'unreadable'. */
export async function readDocx(b: Uint8Array): Promise<string> {
  const entry = await open(b);
  const size = declaredSize(entry);
  if (!Number.isFinite(size) || size > MAX_DOCX_XML_BYTES) throw new ParseError('zipBomb'); // BEFORE inflating
  let xml: string;
  try {
    xml = await entry.async('string');
  } catch {
    throw new ParseError('unreadable');
  }
  const text = docxText(xml);
  if (!text.trim()) throw new ParseError('noText');
  if (text.length > MAX_TEXT_CHARS) throw new ParseError('tooLong');
  return text;
}

type Frame = { kind: 'cell'; parts: string[] } | { kind: 'row'; cells: string[] };

/** word/document.xml as text. PURE; THROWS 'unreadable' for XML that does not parse. */
export function docxText(xml: string): string {
  const blocks: { text: string; row: boolean }[] = [];
  const stack: Frame[] = [];
  let para = '';
  let level = 0; // the open paragraph's heading level, 0 for none
  let inText = false;
  let skip = 0; // inside a tracked deletion, a picture or a drawing's text box
  const emit = (text: string, row: boolean): void => {
    const top = stack[stack.length - 1];
    if (top && top.kind === 'cell') top.parts.push(text);
    else blocks.push({ text, row });
  };
  const p = new SaxesParser();
  p.on('opentag', (tag) => {
    const n = tag.name;
    if (n === 'w:del' || n === 'w:drawing' || n === 'w:pict') skip++;
    else if (skip) return;
    else if (n === 'w:p') { para = ''; level = 0; }
    else if (n === 'w:pStyle') {
      const m = /^heading\s*([1-6])$/i.exec(String(tag.attributes['w:val'] ?? ''));
      if (m) level = Number(m[1]);
    }
    else if (n === 'w:t') inText = true;
    else if (n === 'w:tab') para += '\t';
    else if (n === 'w:br' || n === 'w:cr') para += '\n';
    else if (n === 'w:tr') stack.push({ kind: 'row', cells: [] });
    else if (n === 'w:tc') stack.push({ kind: 'cell', parts: [] });
  });
  p.on('text', (t) => { if (inText && !skip) para += t; });
  p.on('closetag', (tag) => {
    const n = tag.name;
    if (n === 'w:del' || n === 'w:drawing' || n === 'w:pict') { skip--; return; }
    if (skip) return;
    if (n === 'w:t') inText = false;
    else if (n === 'w:p') {
      const t = para.replace(/[ \t]+\n/g, '\n').trim();
      if (t) emit(level ? `${'#'.repeat(level)} ${t.replace(/\s*\n\s*/g, ' ')}` : t, false);
    }
    else if (n === 'w:tc') {
      const f = stack.pop();
      const row = stack[stack.length - 1];
      if (f && f.kind === 'cell' && row && row.kind === 'row') row.cells.push(f.parts.join(' ').replace(/\s+/g, ' ').trim());
    }
    else if (n === 'w:tr') {
      const f = stack.pop();
      if (f && f.kind === 'row' && f.cells.some(Boolean)) emit(f.cells.join(' | '), true);
    }
  });
  try {
    p.write(xml).close();
  } catch {
    throw new ParseError('unreadable');
  }
  return blocks.map((b, i) => (i === 0 ? '' : b.row && blocks[i - 1].row ? '\n' : '\n\n') + b.text).join('');
}
