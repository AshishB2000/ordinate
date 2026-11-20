// Knowledge documents: reading files (docs/knowledge-docs/00-design.md, "Reading files").
//   § 1 the type comes from the BYTES: .md/.txt (BOM dropped, invalid UTF-8 refused), a .docx renamed .pdf read as docx,
//       an old .doc refused naming the types accepted, another zip (xlsx) refused
//   § 2 .docx (built here with jszip): headings, tables, tabs, breaks; tracked deletions and drawings left out; a zip
//       bomb refused BEFORE it is inflated
//   § 3 PDF (committed fixtures): text read; encrypted refused; no text (a scan) refused, each with its own sentence
//   § 4 the worker thread: results arrive through it; a hung worker is terminated at the time limit
//   § 5 isolation: eval is off, nothing opens a socket, and the native canvas never loads
// NEGATIVE CONTROLS: a file within the limit IS inflated; the socket spy sees a real connect; the canvas loads without the hook.
//
//   npm run build:ts && node scripts/test-knowledgeParse.js

export {};
import { ok, finish } from './selfcheck';
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const net: typeof import('net') = require('net');
const cp: typeof import('child_process') = require('child_process');
const JSZip: typeof import('jszip') = require('jszip');
const { parseBytes } = require('../src/knowledge/parse') as typeof import('../src/knowledge/parse');
const { readDocument, setChildForTest, KnowledgeReadError } = require('../src/knowledge/readDocument') as typeof import('../src/knowledge/readDocument');
const { docxText } = require('../src/knowledge/docx') as typeof import('../src/knowledge/docx');
const { PDF_OPTIONS } = require('../src/knowledge/pdf') as typeof import('../src/knowledge/pdf');
const msg = require('../src/knowledge/knowledgeMessages') as typeof import('../src/knowledge/knowledgeMessages');

const fx = (f: string): Buffer => fs.readFileSync(path.join(__dirname, 'fixtures', 'knowledge', f));
const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');
/** What a parse refuses with, or '' when it reads. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string, style?: string): string => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const docx = async (body: string, entry = 'word/document.xml'): Promise<Buffer> => {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file(entry, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};

async function main(): Promise<void> {
  // § 1 text and types
  const md = await parseBytes(utf8('﻿# Title\r\nBody line.\r\n'), 'policy.md');
  ok('markdown: read, BOM dropped, newlines as \\n', md.source === 'markdown' && md.text === '# Title\nBody line.\n', JSON.stringify(md));
  ok('a .txt is text', (await parseBytes(utf8('plain words'), 'notes.txt')).source === 'text');
  ok('the type is the bytes, not the name: markdown in a file called .pdf is text', (await parseBytes(utf8('# Hi'), 'x.pdf')).source === 'text');
  ok('invalid UTF-8 is refused', (await codeOf(parseBytes(Buffer.from([0x68, 0xff, 0xfe, 0x69]), 'a.txt'))) === 'utf8');
  ok('NEGATIVE CONTROL: valid non-ASCII UTF-8 reads', (await parseBytes(utf8('café ☕ 日本'), 'a.txt')).text === 'café ☕ 日本');
  ok('an old binary .doc is refused naming the types accepted', (await codeOf(parseBytes(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]), 'old.doc'))) === 'type' && msg.typeNotAccepted().includes('PDF') && msg.typeNotAccepted().includes('.docx') && msg.typeNotAccepted().includes('.md'));
  ok('a NUL byte means binary: refused', (await codeOf(parseBytes(Buffer.from([0x61, 0, 0x62]), 'a.txt'))) === 'type');
  ok('empty text: refused as no text', (await codeOf(parseBytes(utf8('  \n '), 'a.txt'))) === 'noText');
  ok('over 300,000 characters is refused, never cut', (await codeOf(parseBytes(utf8('a'.repeat(300_001)), 'a.txt'))) === 'tooLong' && (await parseBytes(utf8('a'.repeat(300_000)), 'a.txt')).text.length === 300_000);

  // § 2 docx
  const body = [
    para('Revenue policy', 'Heading1'), para('Net of discounts.'), para('Refunds', 'Heading 2'),
    '<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>b</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>c</w:t></w:r></w:p>',
    '<w:tbl><w:tr><w:tc>' + para('Region') + '</w:tc><w:tc>' + para('Rule') + '</w:tc></w:tr><w:tr><w:tc>' + para('EU') + '</w:tc><w:tc>' + para('ship country') + para('not billing') + '</w:tc></w:tr></w:tbl>',
    '<w:p><w:del><w:r><w:t>deleted words</w:t></w:r></w:del><w:ins><w:r><w:t>inserted words</w:t></w:r></w:ins></w:p>',
    '<w:p><w:r><w:drawing><wp:txbx><w:p><w:r><w:t>picture text</w:t></w:r></w:p></wp:txbx></w:drawing></w:r></w:p>',
    para('Ünïcode &amp; entities'),
  ].join('');
  const d = await parseBytes(await docx(body), 'policy.docx');
  ok('docx: source', d.source === 'docx');
  ok('docx: headings become Markdown headings', d.text.startsWith('# Revenue policy\n\nNet of discounts.\n\n## Refunds'), d.text);
  ok('docx: tabs and breaks', d.text.includes('a\tb\nc'), JSON.stringify(d.text));
  ok('docx: a table row is a | b', d.text.includes('Region | Rule\nEU | ship country not billing'), JSON.stringify(d.text));
  ok('docx: tracked deletions and pictures are left out', !d.text.includes('deleted words') && !d.text.includes('picture text') && d.text.includes('inserted words'));
  ok('docx: entities decode', d.text.includes('Ünïcode & entities'));
  const asInsert = docxText(`<w:document ${W}><w:body><w:p><w:ins><w:r><w:t>deleted words</w:t></w:r></w:ins></w:p></w:body></w:document>`);
  const asDelete = docxText(`<w:document ${W}><w:body><w:p><w:del><w:r><w:t>deleted words</w:t></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p></w:body></w:document>`);
  ok('NEGATIVE CONTROL: the same w:t inside w:ins is kept, inside w:del it is skipped (the skip is what removes it)', asInsert === 'deleted words' && asDelete === 'kept', `${asInsert} / ${asDelete}`);
  ok('a .docx renamed .pdf is read as docx', (await parseBytes(await docx(para('Hello')), 'renamed.pdf')).source === 'docx');
  ok('another zip (no word/document.xml) is refused naming the types', (await codeOf(parseBytes(await docx(para('x'), 'xl/workbook.xml'), 'sheet.docx'))) === 'type');
  ok('a broken zip is refused', (await codeOf(parseBytes(Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('garbage garbage')]), 'x.docx'))) === 'type');
  ok('an empty docx has no text', (await codeOf(parseBytes(await docx(''), 'e.docx'))) === 'noText');
  ok('malformed XML is unreadable', (await codeOf(parseBytes(await docx('<w:p><w:r><w:t>unclosed'), 'bad.docx'))) === 'unreadable');

  // A zip bomb: document.xml is 60 MB of text, a few KB deflated. Refused from the declared size, before inflating.
  const bomb = await docx('<w:p><w:r><w:t>' + 'A'.repeat(60 * 1024 * 1024) + '</w:t></w:r></w:p>');
  ok('the bomb is small on disk', bomb.length < 200_000, String(bomb.length));
  const inflated: string[] = [];
  const realLoad = JSZip.loadAsync.bind(JSZip);
  (JSZip as unknown as { loadAsync: unknown }).loadAsync = async (b: Buffer) => {
    const zip = await realLoad(b);
    const file = zip.file.bind(zip);
    // any: wrapping jszip's overloaded file() to see which entries are inflated
    (zip as any).file = (name: any) => {
      const e = file(name);
      if (e && typeof name === 'string') {
        const real = e.async.bind(e);
        (e as any).async = (...a: any[]) => { inflated.push(name); return (real as any)(...a); };
        const stream = e.nodeStream.bind(e);
        (e as any).nodeStream = (...a: any[]) => { inflated.push(name); return (stream as any)(...a); };
      }
      return e;
    };
    return zip;
  };
  ok('a zip bomb is refused', (await codeOf(parseBytes(bomb, 'bomb.docx'))) === 'zipBomb');
  ok('and was never inflated', inflated.length === 0, JSON.stringify(inflated));
  await parseBytes(await docx(para('small and honest')), 'ok.docx');
  ok('NEGATIVE CONTROL: a file within the limit IS inflated', inflated.includes('word/document.xml'));
  (JSZip as unknown as { loadAsync: unknown }).loadAsync = realLoad;

  // § 3 PDF, through the worker thread
  const hello = await readDocument(fx('hello.pdf'), 'hello.pdf');
  ok('pdf: text read through the worker', hello.source === 'pdf' && hello.text === 'Refunds are deducted from net revenue.\nThe fiscal year starts on 1 February.', JSON.stringify(hello));
  const locked = await codeOf(readDocument(fx('locked.pdf'), 'locked.pdf'));
  ok('pdf: encrypted is refused, with its own sentence', locked === 'encrypted');
  const scan = await codeOf(readDocument(fx('scan.pdf'), 'scan.pdf'));
  ok('pdf: no text (a scan) is refused, with its own sentence', scan === 'noText' && msg.encrypted() !== msg.noText());
  ok('pdf: read through readDocument, the refusal carries the sentence', await (async () => {
    try { await readDocument(fx('locked.pdf'), 'locked.pdf'); return false; } catch (e) { return e instanceof KnowledgeReadError && e.message === msg.encrypted(); }
  })());
  ok('NEGATIVE CONTROL: damaged pdf bytes are unreadable, not a crash', (await codeOf(readDocument(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('not a pdf at all')]), 'x.pdf'))) === 'unreadable');
  ok('a docx through the worker', (await readDocument(await docx(para('Through the worker')), 'w.docx')).text === 'Through the worker');
  ok('a file over 10 MB is refused before a worker starts', (await codeOf(readDocument(Buffer.alloc(10 * 1024 * 1024 + 1, 0x61), 'big.txt'))) === 'type');

  // § 4 a hung worker is terminated at the limit
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-knowledge-'));
  const marker = path.join(dir, 'beat');
  const hang = path.join(dir, 'hang.js');
  fs.writeFileSync(hang, `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);`);
  setChildForTest(hang, 400);
  const t0 = Date.now();
  const hung = await codeOf(readDocument(utf8('hello'), 'a.txt'));
  setChildForTest(null);
  ok('a hung worker times out, with its own sentence', hung === 'timeout' && Date.now() - t0 < 5000 && msg.timedOut().length > 0, `${hung} ${Date.now() - t0}`);
  await new Promise((r) => setTimeout(r, 150));
  const size = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
  await new Promise((r) => setTimeout(r, 300));
  ok('the worker was terminated (its heartbeat stopped)', size > 0 && fs.statSync(marker).size === size, String(size));
  ok('NEGATIVE CONTROL: the real worker answers well within the limit', (await codeOf(readDocument(utf8('hello'), 'a.txt'))) === '');
  fs.rmSync(dir, { recursive: true, force: true });

  // § 5 isolation
  ok('eval is off (CVE-2024-4367) and nothing loads from a URL or a font', PDF_OPTIONS.isEvalSupported === false && PDF_OPTIONS.disableFontFace === true && PDF_OPTIONS.useSystemFonts === false && PDF_OPTIONS.useWorkerFetch === false);
  const pdfSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'knowledge', 'pdf.ts'), 'utf8');
  ok('getDocument is only ever handed those options and bytes', /getDocument\(\{ \.\.\.PDF_OPTIONS, data: /.test(pdfSrc) && !/\burl\s*:/.test(pdfSrc.replace(/\/\/.*$/gm, '')));
  let sockets = 0;
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: import('net').Socket, ...a: unknown[]) { sockets++; return (realConnect as any).apply(this, a); } as typeof realConnect;
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = ((...a: unknown[]) => { fetches++; return (realFetch as any)(...a); }) as typeof fetch;
  await parseBytes(fx('hello.pdf'), 'hello.pdf');
  await parseBytes(await docx(para('x')), 'a.docx');
  ok('nothing in the parse opens a socket or fetches', sockets === 0 && fetches === 0, `${sockets} ${fetches}`);
  const s = net.connect(1, '127.0.0.1');
  s.on('error', () => undefined);
  s.destroy();
  ok('NEGATIVE CONTROL: the spy sees a real connect', sockets === 1);
  net.Socket.prototype.connect = realConnect;
  globalThis.fetch = realFetch;

  ok('the native canvas was never loaded', !Object.keys(require.cache).some((k) => /@napi-rs[\\/]canvas/.test(k)));
  ok('and a require of it is refused in this thread', (() => { try { require('@napi-rs/canvas'); return false; } catch (e) { return /native canvas is not loaded/.test(String((e as Error).message)); } })());
  const bare = cp.spawnSync(process.execPath, ['-e', "try{require('@napi-rs/canvas');process.stdout.write('loaded')}catch(e){process.stdout.write('failed')}"], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  ok('NEGATIVE CONTROL: without the hook the package loads (the hook is what keeps it out)', bare.stdout === 'loaded', bare.stdout + bare.stderr.slice(0, 200));
  finish();
}
main().catch((e) => { console.error(e); process.exitCode = 1; finish(); });
