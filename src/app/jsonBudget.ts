// How many values a JSON text holds, counted BEFORE it is parsed — main
// process and worker threads alike (no imports).
//
// JSON.parse's heap is not its bytes. `{"rules":[{},{},…]}` costs about 110
// bytes of RSS per 3-byte `{},`: a 33 KB bundle could inflate to 32 MiB of it
// and 1.2 GB of heap (refutation S1). What a parse costs is its VALUE count —
// measured, 1,000,000 values cost at most +113 MB RSS (every one an empty
// object; arrays +39 MB, numbers or strings +10 MB) and 56 ms. The largest real
// record, an input table's version (10,000 × 50 cells), is ~510,000 values.
// So nothing a bundle, a backup or a stored project record holds is parsed
// past MAX_JSON_VALUES (src/app/bundleImport.ts, src/app/recordFs.ts).

export const MAX_JSON_VALUES = 1_000_000;

/** The scan's state across windows: inside a string, after a backslash, values so far. */
interface Scan { inString: boolean; escaped: boolean; values: number }

const fresh = (): Scan => ({ inString: false, escaped: false, values: 1 });

/** Every `{`, `[` and `,` outside a string, over bytes [from, to). */
function scanBytes(u8: Uint8Array, from: number, to: number, s: Scan): void {
  let { inString, escaped, values } = s;
  for (let i = from; i < to; i++) {
    const b = u8[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (b === 0x5c) escaped = true;
      else if (b === 0x22) inString = false;
    } else if (b === 0x22) inString = true;
    else if (b === 0x7b || b === 0x5b || b === 0x2c) values++;
  }
  s.inString = inString;
  s.escaped = escaped;
  s.values = values;
}

/** The same over a string's UTF-16 units (the six characters that matter are ASCII). */
function scanString(text: string, s: Scan): void {
  let { inString, escaped, values } = s;
  for (let i = 0; i < text.length; i++) {
    const b = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (b === 0x5c) escaped = true;
      else if (b === 0x22) inString = false;
    } else if (b === 0x22) inString = true;
    else if (b === 0x7b || b === 0x5b || b === 0x2c) values++;
  }
  s.values = values;
}

/** The values `text` holds (an upper bound: every container and separator counts). */
export function countJsonValues(text: string | Uint8Array): number {
  const s = fresh();
  if (typeof text === 'string') scanString(text, s);
  else scanBytes(text, 0, text.length, s);
  return s.values;
}

/**
 * `countJsonValues` over bytes, a window at a time, yielding to the event loop
 * whenever ~10 ms have passed — an import never stalls the pod on a big entry.
 */
export async function countJsonValuesAsync(u8: Uint8Array): Promise<number> {
  const s = fresh();
  const WINDOW = 512 * 1024;
  let t = Date.now();
  for (let at = 0; at < u8.length; at += WINDOW) {
    scanBytes(u8, at, Math.min(u8.length, at + WINDOW), s);
    if (Date.now() - t >= 10) {
      await new Promise<void>((r) => setImmediate(r));
      t = Date.now();
    }
  }
  return s.values;
}

export class JsonTooComplex extends Error {
  constructor(values: number) {
    super(`a JSON text of ${values} values, past ${MAX_JSON_VALUES}`);
    this.name = 'JsonTooComplex';
  }
}

/** JSON.parse, only when `buf` holds at most MAX_JSON_VALUES values; else JsonTooComplex. */
export async function parseBounded(buf: Uint8Array): Promise<unknown> {
  const values = await countJsonValuesAsync(buf);
  if (values > MAX_JSON_VALUES) throw new JsonTooComplex(values);
  return JSON.parse(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf8'));
}
