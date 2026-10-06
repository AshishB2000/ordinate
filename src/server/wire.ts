// The RPC wire codec: tagged JSON that carries what JSON drops.
//
// On the desktop app a handler's reply reached the window by STRUCTURED CLONE, so
// a NaN stayed NaN and a Map stayed a Map. Plain JSON would turn NaN into null —
// a figure silently wrong, the one thing the app must never do. This codec makes
// `decode(encode(x))` equal `structuredClone(x)` (scripts/test-wire.ts proves it
// differentially, leaf by leaf with Object.is, on real handler outputs).
//
// Imported by the server AND the web client: no Node imports, no Buffer.
//
// Format: a special value is a one-key-plus-payload object whose "$" names it:
//   NaN {"$":"NaN"} · Infinity {"$":"Inf"} · -Infinity {"$":"-Inf"} · -0 {"$":"-0"}
//   undefined {"$":"u"} · array hole {"$":"h"} · BigInt {"$":"B","v":"123"}
//   Date {"$":"D","v":<ms, itself encoded — an Invalid Date is NaN>}
//   Map {"$":"M","v":[[k,v],…]} · Set {"$":"S","v":[…]} · Uint8Array {"$":"U8","v":"<base64>"}
// A PLAIN object that has its own "$" key is escaped as {"$":"O","v":{…}}, whose
// `v` keys are taken literally — so no payload can forge a tag.
//
// Buffer decodes as a Uint8Array, because that is what structuredClone gives
// for a Buffer. Shared references are copied, not shared,
// and a cycle throws: JSON has no references. Values structuredClone would
// silently reshape or JSON would silently mangle (other typed arrays,
// ArrayBuffer, RegExp, Error, functions, symbols) THROW — loud, never wrong.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const tag = (t: string, v?: Json): Json => (v === undefined ? { $: t } : { $: t, v });

function toB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function enc(x: unknown, stack: Set<object>): Json {
  switch (typeof x) {
    case 'number':
      if (Number.isNaN(x)) return tag('NaN');
      if (x === Infinity) return tag('Inf');
      if (x === -Infinity) return tag('-Inf');
      return Object.is(x, -0) ? tag('-0') : x;
    case 'string':
    case 'boolean':
      return x;
    case 'undefined':
      return tag('u');
    case 'bigint':
      return tag('B', x.toString());
    case 'object':
      break;
    default:
      throw new TypeError(`wire: cannot encode a ${typeof x}`);
  }
  if (x === null) return null;
  if (stack.has(x)) throw new TypeError('wire: cannot encode a cycle');
  stack.add(x);
  try {
    if (Array.isArray(x)) {
      const out: Json[] = new Array<Json>(x.length);
      for (let i = 0; i < x.length; i += 1) out[i] = i in x ? enc(x[i], stack) : tag('h');
      return out;
    }
    if (x instanceof Date) return tag('D', enc(x.getTime(), stack));
    if (x instanceof Map) return tag('M', [...x].map(([k, v]) => [enc(k, stack), enc(v, stack)]));
    if (x instanceof Set) return tag('S', [...x].map((v) => enc(v, stack)));
    if (x instanceof Uint8Array) return tag('U8', toB64(x)); // Buffer included
    if (ArrayBuffer.isView(x) || x instanceof ArrayBuffer || x instanceof RegExp || x instanceof Error) {
      throw new TypeError(`wire: cannot encode a ${Object.prototype.toString.call(x)}`);
    }
    // Any other object goes as its own enumerable string keys — what
    // structuredClone does to a class instance.
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(x)) defineKey(out, k, enc((x as Record<string, unknown>)[k], stack));
    return Object.prototype.hasOwnProperty.call(x, '$') ? tag('O', out) : out;
  } finally {
    stack.delete(x);
  }
}

/** `out[k] = v` that cannot hit a setter — a "__proto__" key stays a key. */
function defineKey(out: object, k: string, v: unknown): void {
  Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function decObject(o: { [k: string]: Json }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) defineKey(out, k, dec(o[k]));
  return out;
}

function bad(why: string): never {
  throw new TypeError(`wire: malformed input (${why})`);
}

function dec(x: Json): unknown {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) {
    const out: unknown[] = new Array<unknown>(x.length);
    for (let i = 0; i < x.length; i += 1) {
      const v = x[i];
      if (!(v !== null && typeof v === 'object' && !Array.isArray(v) && v.$ === 'h')) out[i] = dec(v);
    }
    return out;
  }
  if (!Object.prototype.hasOwnProperty.call(x, '$')) return decObject(x);
  const v = x.v;
  switch (x.$) {
    case 'NaN': return NaN;
    case 'Inf': return Infinity;
    case '-Inf': return -Infinity;
    case '-0': return -0;
    case 'u': return undefined;
    case 'B': return typeof v === 'string' && /^-?\d+$/.test(v) ? BigInt(v) : bad('bigint');
    case 'D': {
      const ms = dec(v as Json);
      return typeof ms === 'number' ? new Date(ms) : bad('date');
    }
    case 'M': return Array.isArray(v) ? new Map(v.map((e) => (Array.isArray(e) && e.length === 2 ? [dec(e[0]), dec(e[1])] : bad('map entry')))) : bad('map');
    case 'S': return Array.isArray(v) ? new Set(v.map(dec)) : bad('set');
    case 'U8': return typeof v === 'string' ? fromB64(v) : bad('bytes');
    case 'O': return v !== null && typeof v === 'object' && !Array.isArray(v) ? decObject(v) : bad('object');
    default: return bad('unknown tag');
  }
}

/** A JSON-safe tree for `x`. Throws TypeError on what it cannot carry faithfully. */
export function toWire(x: unknown): Json {
  return enc(x, new Set());
}

/** The value a `toWire` tree stands for. Throws TypeError on a malformed tree. */
export function fromWire(x: unknown): unknown {
  return dec(x as Json);
}

export function encode(x: unknown): string {
  return JSON.stringify(toWire(x));
}

export function decode(text: string): unknown {
  return fromWire(JSON.parse(text));
}
