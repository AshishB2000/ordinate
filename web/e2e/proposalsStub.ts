// The model provider the metric-proposals e2e talks to (./proposals.e2e.ts): an Anthropic Messages API look-alike on loopback, in
// this process — no real network call is made. A streamed ask about gross margin gets a chart that names a measure the data does
// not have until the project DEFINES one (its facts then name the metric, and the answer is plain words); the
// draft call (src/ai/proposalDraft.ts PROPOSE_SYSTEM) gets the metric as STRUCTURE: a name, a formula, words, no figure.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after } from 'node:test';

export const ASK = 'Gross margin by region last quarter';
export const calls = { draft: 0 };
/** What the draft call was sent (the questions, the datasets and the columns), and what the last ask was told. */
export const seen = { draft: '', ask: '' };

const REFUSED = `\n@@ACTION ${JSON.stringify({ kind: 'answer', intent: ASK, spec: { dataset: 'Sales', category: 'region', measures: [{ column: 'gross margin', aggregation: 'sum' }] } })}`;
export const DRAFT = { kind: 'metric', name: 'Gross margin', dataset: 'Sales', formula: '(sum(revenue) - sum(cost)) / sum(revenue)', description: 'Revenue minus cost, as a share of revenue.', aliases: ['margin', 'GM'], format: 'percent' };

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-stub', display_name: 'Claude Sonnet Stub', created_at: 2 }] }));
      return;
    }
    const json = JSON.parse(body || '{}') as { stream?: boolean; system?: unknown; messages?: { content: unknown }[] };
    const asked = JSON.stringify(json.messages?.at(-1)?.content ?? '');
    if (!json.stream) {
      const drafting = JSON.stringify(json.system ?? '').includes('define a missing metric or business term');
      if (drafting) { calls.draft += 1; seen.draft = asked; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: drafting ? JSON.stringify(DRAFT) : 'OK' }], stop_reason: 'end_turn' }));
      return;
    }
    seen.ask = asked;
    const defined = asked.includes('- Metric Gross margin'); // the facts name a defined metric that matches the question
    const parts = asked.includes(ASK) ? (defined ? ['Gross margin is now a defined metric.'] : ['Here is gross margin by region.', REFUSED]) : ['OK'];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const tick = setInterval(() => {
      if (i < parts.length) {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: parts[i++] } })}\n\n`);
        return;
      }
      clearInterval(tick);
      res.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    }, 100);
  });
});
await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
export const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
after(() => stub.close());
