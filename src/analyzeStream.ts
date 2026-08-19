// Streaming (SSE) variant of the BYOK provider call. MAIN PROCESS ONLY — the API
// key never leaves main, exactly as in src/analyze.ts.
//
// WHY A SEPARATE FILE. src/analyze.ts is frozen at its file-size cap
// (scripts/test-file-size.ts), so the SSE parsing and the streamed fetch loop
// live here and analyze.ts only imports `streamProvider`. This is the STREAMING
// twin of analyze.ts's buffered `callProvider`: it reuses the SAME per-provider
// request builders (the `ADAPTERS` table in analyze.ts) so the request shape can
// never drift, and it maps the SAME typed errors, so a stream that 401s or times
// out mid-way returns the identical error object the buffered path would — one
// error path, never a half-answer.
//
// The ONLY thing this adds over the buffered path is the RESPONSE side: each
// provider streams a different SSE shape (Anthropic `content_block_delta`, OpenAI
// `choices[].delta.content`, Gemini candidate parts), so there is a per-provider
// `parseDelta`. scripts/test-analyzeStream.ts is a DIFFERENTIAL test: it feeds a
// recorded SSE fixture through the accumulator here and asserts the concatenated
// deltas equal what analyze.ts's buffered `extract()` returns for the same
// completed body — so the two response parsers can never disagree.
//
// STREAMING CHANGES ONLY HOW THE NARRATION TEXT ARRIVES. It does not touch
// buildFacts, provenance or persistence: those are computed in main BEFORE the
// model is called and stored on the assistant turn independent of the reply text
// (src/ipc/copilot.ts). No number is ever parsed out of a streamed token.

import { net } from 'electron';
// Reused from analyze.ts. The `import type` ones are erased at compile time (no
// runtime require, so no load-order hazard); the value imports are read only
// inside functions at call time, which in CommonJS is after both modules have
// finished loading — so the analyze.ts ⇄ analyzeStream.ts cycle is safe.
import { ADAPTERS, parseMaxTokens, errNetwork, errAuth, errRateLimit, errProvider, errTruncated } from './analyze';
import type { NeutralMsg, ProviderOpts, CallResult, WireReq } from './analyze';

// Streaming can legitimately run longer than a buffered call (tokens trickle in),
// but a copilot answer is short prose; keep the same 60s cap the buffered path
// uses so a stuck stream fails cleanly with the same errNetwork the user knows.
const STREAM_TIMEOUT_MS = 60000;

// One streamed delta, normalized across providers: the text to append (absent for
// non-text frames — ping, role headers, tool events) and a cutoff flag set when
// the provider stopped at the max-tokens cap (mapped to errTruncated, matching the
// buffered `adapter.cutoff` check).
type Delta = { text?: string; cutoff?: boolean };

// The OpenAI Chat Completions stream shape — shared by the OpenAI-compatible
// gateway, exactly as `buildOpenAI` is shared in analyze.ts's ADAPTERS.
const OPENAI_STREAM = {
  toStream: (r: WireReq): WireReq => ({ ...r, body: { ...r.body, stream: true } }),
  parseDelta: (o: any): Delta => {
    const ch = o && o.choices && o.choices[0];
    const out: Delta = {};
    const d = ch && ch.delta && ch.delta.content;
    if (typeof d === 'string' && d) out.text = d;
    if (ch && ch.finish_reason === 'length') out.cutoff = true;
    return out;
  },
};

// The STREAMING half of the adapter table: `toStream` turns a buffered WireReq
// (from ADAPTERS[provider].build) into its streaming form — a flag for
// Anthropic/OpenAI, a different endpoint for Gemini — WITHOUT changing the
// buffered builder other callers still use. `parseDelta` reads ONE decoded SSE
// JSON frame into a normalized Delta.
const STREAM: Record<string, { toStream(req: WireReq): WireReq; parseDelta(obj: any): Delta }> = {
  anthropic: {
    toStream: (r) => ({ ...r, body: { ...r.body, stream: true } }),
    parseDelta: (o) => {
      if (o && o.type === 'content_block_delta' && o.delta && typeof o.delta.text === 'string') {
        return { text: o.delta.text };
      }
      if (o && o.type === 'message_delta' && o.delta && o.delta.stop_reason === 'max_tokens') {
        return { cutoff: true };
      }
      return {};
    },
  },
  openai: OPENAI_STREAM,
  gateway: OPENAI_STREAM,
  gemini: {
    // Gemini streams from a DIFFERENT endpoint (:streamGenerateContent) with
    // `alt=sse` so the body is Server-Sent Events rather than a JSON array; the
    // request body itself is unchanged. The buffered build produced
    // `…/models/<model>:generateContent?key=<key>`.
    toStream: (r) => ({
      ...r,
      url: r.url.replace(':generateContent', ':streamGenerateContent').replace('?key=', '?alt=sse&key='),
    }),
    parseDelta: (o) => {
      const c = o && o.candidates && o.candidates[0];
      const parts = (c && c.content && c.content.parts) || [];
      const text = parts.map((p: any) => (p && typeof p.text === 'string' ? p.text : '')).join('');
      const out: Delta = {};
      if (text) out.text = text;
      if (c && c.finishReason === 'MAX_TOKENS') out.cutoff = true;
      return out;
    },
  },
};

// A line-buffered SSE reader. Bytes arrive in arbitrary chunks, so text is
// buffered and drained one `\n`-terminated line at a time; each `data:` line
// carries one JSON frame (every provider here emits single-line data frames).
// The accumulator keeps the full text for the final return AND fires onDelta per
// text frame — the two are the same string, so the streamed preview and the
// buffered answer are byte-identical.
function makeSSEAccumulator(provider: string, onDelta: (delta: string) => void) {
  const parse = (STREAM[provider] || OPENAI_STREAM).parseDelta;
  let buf = '';
  let text = '';
  let cutoff = false;

  function handleData(data: string): void {
    if (!data || data === '[DONE]') return; // OpenAI terminates the stream with [DONE]
    let obj: any;
    try { obj = JSON.parse(data); } catch (_) { return; } // a partial/again frame — skip, never throw
    const r = parse(obj);
    if (r.cutoff) cutoff = true;
    if (r.text) { text += r.text; onDelta(r.text); }
  }

  function drain(final: boolean): void {
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      const m = /^data:\s?(.*)$/.exec(line);
      if (m) handleData(m[1]);
    }
    if (final && buf) {
      const m = /^data:\s?(.*)$/.exec(buf.replace(/\r$/, ''));
      if (m) handleData(m[1]);
      buf = '';
    }
  }

  return {
    push(chunk: string): void { buf += chunk; drain(false); },
    end(): void { drain(true); },
    get text(): string { return text; },
    get cutoff(): boolean { return cutoff; },
  };
}

// Map a non-OK streaming response to the SAME typed error the buffered
// callProvider produces — read the body once for a real reason, then status →
// auth / rate_limit / provider. Kept in step with analyze.ts's !res.ok block.
async function mapHttpError(label: string, res: any): Promise<any> {
  let errCode = '';
  try {
    const t = await res.text();
    try {
      const e = JSON.parse(t);
      const d = (e && e.error) || e;
      errCode = d ? String(d.message || d.type || d.code || d.status || '') : '';
    } catch (_) { errCode = (t || '').trim(); }
  } catch (_) { /* body already consumed / unreadable */ }
  if (errCode.length > 300) errCode = errCode.slice(0, 300) + '…';
  console.error('[analyzeStream]', label, 'error', res.status, errCode || '(no detail)');
  const detail = `${label} · ${res.status}${errCode ? ' · ' + errCode : ''}`;
  if (res.status === 401 || res.status === 403) return Object.assign(errAuth(), { detail });
  if (res.status === 429) return Object.assign(errRateLimit(), { detail });
  return Object.assign(errProvider(), { detail });
}

// Streaming twin of analyze.ts's callProvider: same { rawText } | { error } shape,
// same typed errors, same 60s AbortController — the ONLY difference is that the
// full text is accumulated from an SSE body and onDelta fires per token. Called
// only from callProvider (byok path) when an onDelta is present; every other
// caller keeps the buffered path byte-for-byte.
export async function streamProvider(
  provider: string,
  systemPrompt: string,
  messages: NeutralMsg[],
  opts: ProviderOpts,
  onDelta: (delta: string) => void,
): Promise<CallResult> {
  const adapter = ADAPTERS[provider];
  const stream = STREAM[provider];
  if (!adapter || !stream) return { error: errProvider() };

  const baseUrl = (opts.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return { error: Object.assign(errProvider(), { detail: `${adapter.label} · no base URL set` }) };

  const req = adapter.build({
    systemPrompt, messages,
    model: opts.model,
    maxTokens: parseMaxTokens(opts.maxTokens),
    apiKey: opts.apiKey,
    baseUrl,
  });
  const sreq = stream.toStream(req);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STREAM_TIMEOUT_MS);
  try {
    const res = await net.fetch(sreq.url, {
      method: 'POST',
      headers: sreq.headers,
      body: JSON.stringify(sreq.body),
      signal: ctrl.signal,
    });
    if (!res.ok) { clearTimeout(timer); return { error: await mapHttpError(adapter.label, res) }; }
    if (!res.body) { clearTimeout(timer); return { error: errProvider() }; }

    const acc = makeSSEAccumulator(provider, onDelta);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) acc.push(decoder.decode(value, { stream: true }));
    }
    acc.end();
    clearTimeout(timer);

    // Cut off at the token cap → the same distinct error the buffered path
    // returns, NOT a truncated half-answer surfaced as success.
    if (acc.cutoff) return { error: errTruncated() };
    return { rawText: acc.text };
  } catch (err: any) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') { console.error('[analyzeStream] request timed out'); return { error: errNetwork() }; }
    console.error('[analyzeStream] fetch error:', err && err.message);
    return { error: errNetwork() };
  }
}

// Pure accumulation over a COMPLETE SSE body — no network. This is exactly the
// path streamProvider runs over live bytes (same makeSSEAccumulator), exposed so
// scripts/test-analyzeStream.ts can assert the concatenated deltas equal the
// buffered ADAPTERS[provider].extract() of the same completed response. Pass an
// array of chunks to reproduce arbitrary wire-boundary splits (a data frame cut
// across two network reads) and prove the line-buffering handles them.
export function accumulateSSE(provider: string, sse: string | string[]): { text: string; cutoff: boolean } {
  const acc = makeSSEAccumulator(provider, () => {});
  for (const chunk of Array.isArray(sse) ? sse : [sse]) acc.push(chunk);
  acc.end();
  return { text: acc.text, cutoff: acc.cutoff };
}
