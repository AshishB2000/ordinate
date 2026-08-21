// Self-check for src/analyzeStream.ts — the per-provider SSE (streaming) parser.
//
// DIFFERENTIAL, the house style: for each BYOK provider a recorded SSE fixture is
// fed through accumulateSSE() (the EXACT accumulator streamProvider runs over live
// bytes) and the concatenated deltas are asserted, with Object.is, to equal what
// analyze.ts's buffered ADAPTERS[provider].extract() returns for the SAME
// completed response body. The streamed preview and the buffered answer are the
// same string or this fails — so the two response parsers can never drift.
//
// Also asserts the max-tokens cutoff is detected the same way on both sides
// (accumulateSSE().cutoff vs adapter.cutoff(body)), and that gateway reuses the
// OpenAI shape. No network: recorded fixtures only.
//
//   npm run build:ts && node scripts/test-analyzeStream.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const fs: typeof import('fs') = require('fs');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-stream-'));

// Same stub the other analyze-graph tests use: enough surface for the module
// graph to load. Nothing here calls net/app — the parsers under test are pure.
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_n: string) => tmpUserData }, net: {} };
  return origLoad.apply(this, [request, ...rest]);
};

const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const stream: typeof import('../src/ai/analyzeStream') = require('../src/ai/analyzeStream');


// The answer every fixture reconstructs — split across two deltas so a broken
// accumulator that keeps only the last frame is caught.
const ANSWER = 'South leads.';

// ── Per-provider fixtures ────────────────────────────────────────────────────
// Each entry: the SSE body (what the wire sends when streaming), the equivalent
// COMPLETED body (what the buffered path parses), and their max-tokens variants.

const ANTHROPIC_SSE =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n' +
  '\n' +
  'event: content_block_start\n' +
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n' +
  '\n' +
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"South "}}\n' +
  '\n' +
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"leads."}}\n' +
  '\n' +
  'event: content_block_stop\n' +
  'data: {"type":"content_block_stop","index":0}\n' +
  '\n' +
  'event: message_delta\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n' +
  '\n' +
  'event: message_stop\n' +
  'data: {"type":"message_stop"}\n';
const ANTHROPIC_BODY = { content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn' };
const ANTHROPIC_SSE_CUT =
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"South "}}\n' +
  '\n' +
  'event: message_delta\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n';
const ANTHROPIC_BODY_CUT = { content: [{ type: 'text', text: 'South ' }], stop_reason: 'max_tokens' };

// OpenAI Chat Completions stream — role header, two content deltas, a stop frame,
// then the [DONE] sentinel (which the accumulator must ignore, not JSON-parse).
const OPENAI_SSE =
  'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n' +
  '\n' +
  'data: {"choices":[{"index":0,"delta":{"content":"South "}}]}\n' +
  '\n' +
  'data: {"choices":[{"index":0,"delta":{"content":"leads."}}]}\n' +
  '\n' +
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n' +
  '\n' +
  'data: [DONE]\n';
const OPENAI_BODY = { choices: [{ message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }] };
const OPENAI_SSE_CUT =
  'data: {"choices":[{"index":0,"delta":{"content":"South "}}]}\n' +
  '\n' +
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n';
const OPENAI_BODY_CUT = { choices: [{ message: { content: 'South ' }, finish_reason: 'length' }] };

// Gemini streamGenerateContent?alt=sse — one candidate per frame, parts carry the
// text; the final frame reports finishReason.
const GEMINI_SSE =
  'data: {"candidates":[{"content":{"parts":[{"text":"South "}],"role":"model"}}]}\n' +
  '\n' +
  'data: {"candidates":[{"content":{"parts":[{"text":"leads."}],"role":"model"},"finishReason":"STOP"}]}\n';
const GEMINI_BODY = { candidates: [{ content: { parts: [{ text: ANSWER }] }, finishReason: 'STOP' }] };
const GEMINI_SSE_CUT =
  'data: {"candidates":[{"content":{"parts":[{"text":"South "}]}}]}\n' +
  '\n' +
  'data: {"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"MAX_TOKENS"}]}\n';
const GEMINI_BODY_CUT = { candidates: [{ content: { parts: [{ text: 'South ' }] }, finishReason: 'MAX_TOKENS' }] };

type Case = { provider: string; sse: string; body: any; sseCut: string; bodyCut: any };
const CASES: Case[] = [
  { provider: 'anthropic', sse: ANTHROPIC_SSE, body: ANTHROPIC_BODY, sseCut: ANTHROPIC_SSE_CUT, bodyCut: ANTHROPIC_BODY_CUT },
  { provider: 'openai', sse: OPENAI_SSE, body: OPENAI_BODY, sseCut: OPENAI_SSE_CUT, bodyCut: OPENAI_BODY_CUT },
  { provider: 'gateway', sse: OPENAI_SSE, body: OPENAI_BODY, sseCut: OPENAI_SSE_CUT, bodyCut: OPENAI_BODY_CUT },
  { provider: 'gemini', sse: GEMINI_SSE, body: GEMINI_BODY, sseCut: GEMINI_SSE_CUT, bodyCut: GEMINI_BODY_CUT },
];

for (const c of CASES) {
  const adapter = (analyze.ADAPTERS as any)[c.provider];
  ok(`${c.provider}: adapter exists`, Boolean(adapter));
  if (!adapter) continue;

  // The whole point: streamed deltas concatenate to the buffered answer.
  const streamed = stream.accumulateSSE(c.provider, c.sse);
  const buffered = adapter.extract(c.body);
  ok(`${c.provider}: streamed deltas equal buffered extract()`, Object.is(streamed.text, buffered));
  ok(`${c.provider}: buffered extract() is the expected answer`, Object.is(buffered, ANSWER));
  ok(`${c.provider}: a normal stream is not flagged cut off`, streamed.cutoff === false);

  // Cutoff detected identically on both sides.
  const streamedCut = stream.accumulateSSE(c.provider, c.sseCut);
  ok(`${c.provider}: streamed max-tokens cutoff detected`, streamedCut.cutoff === true);
  ok(`${c.provider}: buffered cutoff() agrees`, adapter.cutoff(c.bodyCut) === true);
  // Even a truncated stream still yields the partial text it did receive.
  ok(`${c.provider}: truncated stream keeps its partial text`, Object.is(streamedCut.text, 'South '));
}

// Chunk boundaries are arbitrary on the wire — a network read can split a data
// frame mid-JSON. Feeding the SAME fixture cut into 1-character chunks must yield
// the identical result as one push (proves the line-buffering across splits).
for (const c of CASES) {
  const whole = stream.accumulateSSE(c.provider, c.sse);
  const split = stream.accumulateSSE(c.provider, c.sse.split(''));
  ok(`${c.provider}: char-split stream matches a single push`,
    Object.is(split.text, whole.text) && Object.is(split.text, ANSWER));
}

Module._load = origLoad;
try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* best effort */ }

console.log('');
if (failureCount()) { console.error(`${failureCount()} analyzeStream check(s) FAILED.`); process.exit(1); }
console.log('All analyzeStream checks passed.');
