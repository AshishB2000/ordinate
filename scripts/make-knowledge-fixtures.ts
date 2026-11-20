// Writes the small PDFs scripts/fixtures/knowledge/ holds (test-knowledgeParse): hand-made, with correct xref offsets.
//   node scripts/make-knowledge-fixtures.js
// hello.pdf     one page of text, two lines
// scan.pdf      one page with a drawn box and no text (what a scan is, to a text reader)
// cjk.pdf       Japanese text in a Type0 font that names a predefined CMap (90ms-RKSJ-H) instead of embedding one
// locked.pdf    asks for a password: an /Encrypt dictionary whose user-password check an empty password fails

import * as fs from 'fs';
import * as path from 'path';

function pdf(objects: string[], trailerExtra = ''): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const stream = (s: string): string => `<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}\nendstream`;
const page = (content: string): string[] => [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  stream(content),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

const dir = path.join(__dirname, 'fixtures', 'knowledge');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'hello.pdf'), pdf(page('BT /F1 14 Tf 72 720 Td (Refunds are deducted from net revenue.) Tj 0 -24 Td (The fiscal year starts on 1 February.) Tj ET')));
fs.writeFileSync(path.join(dir, 'scan.pdf'), pdf(page('0.8 g 72 600 300 120 re f')));
const lockedObjects = page('BT /F1 14 Tf 72 720 Td (secret) Tj ET');
lockedObjects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -4 >>`);
fs.writeFileSync(path.join(dir, 'locked.pdf'), pdf(lockedObjects, '/Encrypt 6 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] '));

// "あい" in Shift-JIS (82A0 82A2), shown through a font that only NAMES its CMap: it reads only if pdf.js can load its cmaps.
const cjk = page('BT /F1 14 Tf 72 720 Td <82A082A2> Tj ET');
cjk[4] = '<< /Type /Font /Subtype /Type0 /BaseFont /MSGothic /Encoding /90ms-RKSJ-H /DescendantFonts [6 0 R] >>';
cjk.push('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MSGothic /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 7 0 R >>');
cjk.push('<< /Type /FontDescriptor /FontName /MSGothic /Flags 4 /FontBBox [0 -137 1000 859] /ItalicAngle 0 /Ascent 859 /Descent -137 /CapHeight 700 /StemV 80 >>');
fs.writeFileSync(path.join(dir, 'cjk.pdf'), pdf(cjk));
