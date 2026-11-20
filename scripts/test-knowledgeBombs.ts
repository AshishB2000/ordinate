// Knowledge documents: hostile files cannot take the pod's memory (docs/knowledge-docs/00-design.md, "Reading files").
//   § 1 a PDF whose content stream inflates to hundreds of MB (a 300 KB file): read in a CHILD PROCESS that is killed past its
//       memory budget, so the parent's RSS stays flat and the upload is refused with the "too large or complex" sentence.
//       pdf.js's decoded buffers sit outside any worker's V8 heap limit, which is why a worker alone is not enough.
//   § 2 a .docx whose header DECLARES 1,000 bytes and inflates past the cap: the output is capped as it is inflated
//   § 3 at most 2 parses run at once per pod; a third waits (and is not refused)
// NEGATIVE CONTROLS: an honest PDF and docx read in the same child; the declared-size check still refuses an honest bomb.
//
//   npm run build:ts && node scripts/test-knowledgeBombs.js

export {};
import { ok, finish } from './selfcheck';
const zlib: typeof import('zlib') = require('zlib');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const JSZip: typeof import('jszip') = require('jszip');
const { readDocument, setChildForTest, KnowledgeReadError } = require('../src/knowledge/readDocument') as typeof import('../src/knowledge/readDocument');
const { readDocx } = require('../src/knowledge/docx') as typeof import('../src/knowledge/docx');
const msg = require('../src/knowledge/knowledgeMessages') as typeof import('../src/knowledge/knowledgeMessages');
const limits = require('../src/knowledge/limits') as typeof import('../src/knowledge/limits');

/** A one-page PDF whose Flate content stream inflates to `mb` megabytes of spaces after one line of text. */
function pdfBomb(mb: number): Buffer {
  const z = zlib.deflateSync(Buffer.concat([Buffer.from('BT /F1 12 Tf 72 720 Td (Hello bomb) Tj ET\n'), Buffer.alloc(mb * 1024 * 1024, 0x20)]), { level: 9 });
  const parts: Buffer[] = [];
  const offs: number[] = [];
  let len = 0;
  const push = (b: Buffer): void => { parts.push(b); len += b.length; };
  push(Buffer.from('%PDF-1.4\n'));
  const obj = (n: number, body: string | Buffer): void => { offs[n] = len; push(Buffer.from(`${n} 0 obj\n`)); push(Buffer.isBuffer(body) ? body : Buffer.from(body)); push(Buffer.from('\nendobj\n')); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  obj(4, Buffer.concat([Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`), z, Buffer.from('\nendstream')]));
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const xref = len;
  push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offs[n]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/** A .docx whose word/document.xml inflates to `mb` MB; with `lie`, its headers declare 1,000 bytes. */
async function docxOf(mb: number, lie: boolean): Promise<Buffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file('word/document.xml', `<w:document ${W}><w:body><w:p><w:r><w:t>${'A'.repeat(mb * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`);
  const b = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (lie) {
    const name = 'word/document.xml';
    for (let i = 0; i < b.length - 46; i++) {
      const sig = b.readUInt32LE(i);
      if (sig === 0x04034b50 && b.subarray(i + 30, i + 30 + name.length).toString() === name) b.writeUInt32LE(1000, i + 22);
      if (sig === 0x02014b50 && b.subarray(i + 46, i + 46 + name.length).toString() === name) b.writeUInt32LE(1000, i + 24);
    }
  }
  return b;
}
const codeOf = async (p: Promise<unknown>): Promise<string> => p.then(() => '', (e: { code?: string }) => e.code ?? String(e));

async function main(): Promise<void> {
  // § 2 first (in process: the cap is in the inflate, not the process)
  const lying = await docxOf(60, true);
  ok('(setup) the lying docx is small on disk and its header declares 1,000 bytes', lying.length < 200_000);
  const r2 = await codeOf(readDocx(lying));
  ok('a docx that declares 1,000 bytes and inflates past the cap is a zip bomb (not "unreadable")', r2 === 'zipBomb', r2);
  const honest = await docxOf(60, false);
  ok('NEGATIVE CONTROL: an honest 60 MB declaration is refused too (the declared-size check stays)', (await codeOf(readDocx(honest))) === 'zipBomb');
  const small = await docxOf(0.2, false);
  ok('NEGATIVE CONTROL: a 200 KB document.xml still reads', (await codeOf(readDocx(small))) === '');

  // § 1 the PDF bomb through the real child process
  const bomb = pdfBomb(300);
  ok('(setup) a 300 MB-inflating PDF is small on disk', bomb.length < 1_000_000, String(bomb.length));
  let peak = 0;
  const base = process.memoryUsage().rss;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  const t0 = Date.now();
  let err: unknown = null;
  await readDocument(bomb, 'bomb.pdf').catch((e) => { err = e; });
  clearInterval(timer);
  const grew = Math.round((peak - base) / 1048576);
  ok('the PDF bomb is refused with the memory refusal', err instanceof KnowledgeReadError && err.code === 'memory' && err.message === msg.tooComplex(), String((err as Error)?.message));
  ok('the parent process grew by under 100 MB while it was read', grew < 100, `${grew} MB`);
  ok('…and it was stopped quickly, not at the 30 s limit', Date.now() - t0 < 15_000, `${Date.now() - t0} ms`);
  ok('the memory budget is one named constant (256 MB)', limits.PARSE_MEMORY_MB === 256);
  const hello = fs.readFileSync(path.join(__dirname, 'fixtures', 'knowledge', 'hello.pdf'));
  ok('NEGATIVE CONTROL: an honest PDF reads fine in the same child process', (await readDocument(hello, 'hello.pdf')).text.includes('Refunds are deducted'));
  ok('…and a parse after a killed one works (nothing is left wedged)', (await readDocument(Buffer.from('plain words'), 'a.txt')).text === 'plain words');

  // § 3 two at a time
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bombs-'));
  const log = path.join(dir, 'log');
  const child = path.join(dir, 'child.js');
  fs.writeFileSync(child, `const fs=require('fs');process.once('message',()=>{fs.appendFileSync(${JSON.stringify(log)},'+\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},'-\\n');process.send({parsed:{source:'text',text:'x'}});setTimeout(()=>process.exit(0),10)},400)})`);
  setChildForTest(child);
  const marks: number[] = [];
  const t1 = Date.now();
  const outs = await Promise.all(Array.from({ length: 5 }, () => readDocument(Buffer.from('x'), 'a.txt').then((r) => { marks.push(Date.now() - t1); return r.text; }, (e: Error) => `refused: ${e.message}`)));
  setChildForTest(null);
  let live = 0;
  let most = 0;
  for (const c of fs.readFileSync(log, 'utf8').trim().split('\n')) { live += c === '+' ? 1 : -1; most = Math.max(most, live); }
  ok('five parses at once: never more than 2 children alive', most === 2, String(most));
  ok('…and the other three waited rather than being refused', outs.every((o) => o === 'x'), JSON.stringify(outs));
  fs.rmSync(dir, { recursive: true, force: true });
  finish();
}
main().catch((e) => { console.error(e); process.exitCode = 1; finish(); });
