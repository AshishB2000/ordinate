// Fingerprints for meaning search (docs/assistant/00-design.md "Scale rules", phase C) — MAIN / SERVER.
//
// A fingerprint is a text's embedding: FINGERPRINT_DIMS numbers made by the
// org's own provider key (Admin → AI), never by a model installed here. It is
// OFF until an org admin picks a model (src/server/aiConfig.ts
// currentFingerprintModel): with none, `fingerprint` refuses before any request.
//
// Requests go through ./providerFetch.ts (SSRF-guarded), FINGERPRINT_BATCH
// texts at most, each under its own timeout joined to the caller's abort
// signal. The key goes in a header, never the URL, and is cut out of any
// provider reason before it is logged or returned.
//
// Every vector is L2-normalized here, whatever the provider: OpenAI's
// `dimensions` already returns unit vectors (then this is a no-op up to
// rounding), gemini-embedding-001 cut to 768 does not, and a gateway may not.
// A reply that is not FINGERPRINT_DIMS long is an error, never padded or cut.

import * as execConfig from '../app/execConfig';
import { formatNumber } from '../app/format';
import { logger } from '../app/logger';
import { redactSecrets } from '../connectors/types';
import { ctx } from '../server/context';
import * as msg from './aiMessages';
import { ADAPTERS, errAuth, errBadReply, errNetwork, errProvider, errRateLimit, type TypedError } from './analyze';
import { providerFetch } from './providerFetch';

export const FINGERPRINT_DIMS = 768;
export const FINGERPRINT_BATCH = 100;
const TIMEOUT_MS = 30_000;
/** What Admin → AI's Test fingerprints. */
const SAMPLE = 'Revenue by region last quarter';

export interface FingerprintModel {
  readonly provider: string;
  readonly model: string;
}
export type Fingerprints = { ok: true; vectors: Float32Array[] } | TypedError;

const fail = (errorType: string, message: string): TypedError => ({ ok: false, errorType, message });

/** One request's wire shape: OpenAI's /embeddings (a gateway's too) or Gemini's batchEmbedContents. */
function embedRequest(pick: FingerprintModel, texts: readonly string[], apiKey: string | null, baseUrl: string): { url: string; headers: Record<string, string>; body: unknown } {
  if (pick.provider === 'gemini') {
    const model = `models/${pick.model}`;
    return {
      url: `${baseUrl}/models/${encodeURIComponent(pick.model)}:batchEmbedContents`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey ?? '' },
      body: { requests: texts.map((text) => ({ model, content: { parts: [{ text }] }, outputDimensionality: FINGERPRINT_DIMS })) },
    };
  }
  return {
    url: `${baseUrl}/embeddings`,
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: { model: pick.model, input: texts, dimensions: FINGERPRINT_DIMS, encoding_format: 'float' },
  };
}

/** The reply's vectors in input order, or null when it is not the shape asked for. */
function vectorsOf(provider: string, json: unknown): unknown[] | null {
  const j = json as { embeddings?: { values?: unknown }[]; data?: { index?: number; embedding?: unknown }[] } | null;
  if (provider === 'gemini') return Array.isArray(j?.embeddings) ? j.embeddings.map((e) => e?.values) : null;
  if (!Array.isArray(j?.data)) return null;
  return [...j.data].sort((a, b) => Number(a?.index) - Number(b?.index)).map((d) => d?.embedding);
}

/** `v` scaled to length 1, or null when it has no length or a number that is not finite. */
export function unit(v: readonly number[]): Float32Array | null {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  return Float32Array.from(v, (x) => x / len);
}

/** The provider's own reason ({error:{message}}, {message} or text), capped as chat calls cap it, the key cut out. */
async function reason(res: Response, apiKey: string | null): Promise<string> {
  const text = await res.text().catch(() => '');
  let why = text.trim();
  try {
    const e = JSON.parse(text) as { error?: unknown; message?: unknown };
    const d = (e && typeof e === 'object' && (e.error ?? e)) as { message?: unknown; status?: unknown; code?: unknown } | string;
    why = typeof d === 'string' ? d : String(d?.message ?? d?.status ?? d?.code ?? '');
  } catch {
    // not JSON: the text itself
  }
  why = redactSecrets(why, apiKey ? { apiKey } : undefined);
  return why.length > 300 ? `${why.slice(0, 300)}…` : why;
}

async function batch(pick: FingerprintModel, texts: readonly string[], apiKey: string | null, baseUrl: string): Promise<Fingerprints> {
  const label = ADAPTERS[pick.provider].label;
  const req = embedRequest(pick, texts, apiKey, baseUrl);
  const outer = ctx().signal;
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await providerFetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
  } catch (err) {
    const e = err as Error;
    logger.error('[fingerprint]', label, e.name === 'TimeoutError' ? 'request timed out' : `fetch error: ${redactSecrets(String(e.message), apiKey ? { apiKey } : undefined)}`);
    return errNetwork();
  }
  if (!res.ok) {
    const why = await reason(res, apiKey);
    logger.error('[fingerprint]', label, 'error', res.status, why || '(no detail)');
    const detail = `${label} · ${res.status}${why ? ` · ${why}` : ''}`;
    if (res.status === 401 || res.status === 403) return { ...errAuth(), detail };
    if (res.status === 429) return { ...errRateLimit(), detail };
    return { ...errProvider(), detail };
  }
  const raw = vectorsOf(pick.provider, await res.json().catch(() => null));
  if (!raw || raw.length !== texts.length) {
    logger.error('[fingerprint]', label, 'reply had', raw ? raw.length : 'no', 'vectors for', texts.length, 'texts');
    return errBadReply();
  }
  const vectors: Float32Array[] = [];
  for (const v of raw) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'number')) return errBadReply();
    if (v.length !== FINGERPRINT_DIMS) return fail('dimensions', msg.fingerprintWrongSize(formatNumber(v.length, { decimals: 0 })));
    const u = unit(v as number[]);
    if (!u) return errBadReply();
    vectors.push(u);
  }
  return { ok: true, vectors };
}

/**
 * `texts`' fingerprints, in order, from `pick` — the org's model
 * (currentFingerprintModel()). Null is off: refused, and nothing is sent.
 */
export async function fingerprint(texts: readonly string[], pick: FingerprintModel | null): Promise<Fingerprints> {
  if (!pick) return fail('off', msg.fingerprintOff());
  if (!['openai', 'gemini', 'gateway'].includes(pick.provider)) return fail('no_model', msg.fingerprintNoModel());
  if (texts.length === 0) return { ok: true, vectors: [] };
  const cred = await execConfig.byokCredentials(pick.provider); // the org's key, as every chat call reads it — main only
  const baseUrl = (cred.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || (pick.provider !== 'gateway' && !cred.apiKey)) return fail('no_key', msg.fingerprintNeedsProvider(ADAPTERS[pick.provider].label));
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += FINGERPRINT_BATCH) {
    const r = await batch(pick, texts.slice(i, i + FINGERPRINT_BATCH), cred.apiKey, baseUrl);
    if (!r.ok) return r;
    vectors.push(...r.vectors);
  }
  return { ok: true, vectors };
}

/** Admin → AI's Test: one short sample through `pick`, with its length and how long the call took (the server's figure). */
export async function testFingerprint(pick: FingerprintModel): Promise<{ ok: true; dimensions: number; ms: number } | TypedError> {
  const started = performance.now();
  const r = await fingerprint([SAMPLE], pick);
  if (!r.ok) return r;
  return { ok: true, dimensions: r.vectors[0].length, ms: Math.round(performance.now() - started) };
}
