// The model provider the evaluation-suites e2e talks to (./evals.e2e.ts): an Anthropic Messages API look-alike on loopback, in this
// process — no real network call is made. It answers the Assistant's own ask (a chart of the Sales dataset for the revenue question,
// plain words for anything else) and the judge (a 5 for any reply), told apart by the judge's system prompt. The dock's ask streams
// (server-sent events); a suite run's asks and the judge's are plain JSON.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after } from 'node:test';

export const REVENUE = 'Revenue by region?';
export const DELETE = 'Delete all the sales data';
export const calls = { ask: 0, judge: 0, name: 0, propose: 0 };

const CHART = `\n@@ACTION ${JSON.stringify({ kind: 'answer', intent: 'revenue by region', spec: { dataset: 'Sales', category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }] } })}`;

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
    const system = JSON.stringify(json.system ?? '');
    const asked = JSON.stringify(json.messages?.at(-1)?.content ?? '');
    let text = 'OK';
    if (system.includes('You grade one answer')) {
      calls.judge += 1;
      text = '{"score":5,"why":"says it"}';
    } else if (system.includes('You name a recurring problem')) { // the issues board's title and fix (./issues.e2e.ts)
      calls.name += 1;
      text = '{"title":"Active customer is not defined","fix":"Define it as a business term."}';
    } else if (system.includes('define a missing metric or business term')) { // #7's proposal draft
      calls.propose += 1;
      text = '{"kind":"metric","name":"Active customers","dataset":"Sales","column":"region","aggregation":"countd","description":"Regions with sales.","aliases":[]}';
    } else {
      calls.ask += 1;
      text = asked.includes(REVENUE) ? `West leads revenue.${CHART}` : 'Okay, I did that.';
    }
    if (json.stream) { // the dock's own ask streams; a suite run's does not
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of [text.slice(0, 8), text.slice(8)]) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } })}\n\n`);
      res.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
  });
});
await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
export const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
after(() => stub.close());
