// A PDF's text (docs/knowledge-docs/00-design.md, "Reading files"): Mozilla's pdf.js, the legacy Node build, text only.
// Runs inside the worker thread (./parseWorker), never on the request thread.
//
// pdf.js polyfills DOMMatrix and Path2D for RENDERING by require()ing the optional native package @napi-rs/canvas when
// it loads. Reading text needs neither, so a resolve hook refuses that package BEFORE the import: pdf.js logs one
// warning and carries on, and no native module is loaded (spiked on pdfjs-dist 6.5.438).

import * as nodeModule from 'module';
import { MAX_TEXT_CHARS } from './limits';
import { ParseError } from './parseTypes';

/** The only options a document is opened with: bytes in hand, never a URL; no eval (CVE-2024-4367); no fonts, no worker fetch. */
export const PDF_OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  useWorkerFetch: false,
  isOffscreenCanvasSupported: false,
  verbosity: 0,
} as const;

interface TextItem { str?: string; hasEOL?: boolean }
interface PdfPage { getTextContent(): Promise<{ items: TextItem[] }>; cleanup(): void }
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> }
interface PdfModule { getDocument(o: Record<string, unknown>): { promise: Promise<PdfDoc>; destroy(): Promise<void> } }

let blocked = false;
/** Refuse the native canvas package for the rest of this thread. Idempotent. */
export function blockNativeCanvas(): void {
  if (blocked) return;
  blocked = true;
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@napi-rs/canvas')) throw new Error('native canvas is not loaded in the document reader');
      return next(specifier, context);
    },
  });
}

/** The text of a PDF, or THROWS 'encrypted' (it asks for a password), 'noText' (a scan), 'tooLong', 'unreadable'. */
export async function readPdf(bytes: Uint8Array): Promise<string> {
  blockNativeCanvas();
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfModule;
  // A copy: pdf.js takes ownership of the buffer it is given.
  const task = pdfjs.getDocument({ ...PDF_OPTIONS, data: new Uint8Array(bytes) });
  let doc: PdfDoc;
  try {
    doc = await task.promise;
  } catch (e) {
    throw new ParseError((e as { name?: string })?.name === 'PasswordException' ? 'encrypted' : 'unreadable');
  }
  try {
    const pages: string[] = [];
    let chars = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      page.cleanup();
      const text = items.map((i) => (i.str ?? '') + (i.hasEOL ? '\n' : '')).join('').replace(/[ \t]+\n/g, '\n').trim();
      if (!text) continue;
      pages.push(text);
      chars += text.length;
      if (chars > MAX_TEXT_CHARS) throw new ParseError('tooLong');
    }
    if (!pages.length) throw new ParseError('noText');
    return pages.join('\n\n');
  } catch (e) {
    throw e instanceof ParseError ? e : new ParseError('unreadable');
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
