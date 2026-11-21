// The model provider the evaluation-suites e2e talks to (./evals.e2e.ts): an Anthropic Messages API look-alike on loopback, in this
// process — no real network call is made. It answers the Assistant's own ask (a chart of the Sales dataset for the revenue question,
// plain words for anything else) and the judge (a 5 for any reply), told apart by the judge's system prompt.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after } from 'node:test';

export const REVENUE = 'Revenue by region?';
export const DELETE = 'Delete all the sales data';
export const calls = { ask: 0, judge: 0 };

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
    const json = JSON.parse(body || '{}') as { system?: unknown; messages?: { content: unknown }[] };
    const system = JSON.stringify(json.system ?? '');
    const asked = JSON.stringify(json.messages?.at(-1)?.content ?? '');
    let text = 'OK';
    if (system.includes('You grade one answer')) {
      calls.judge += 1;
      text = '{"score":5,"why":"says it"}';
    } else {
      calls.ask += 1;
      text = asked.includes(REVENUE) ? `West leads revenue.${CHART}` : 'Okay, I did that.';
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
  });
});
await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
export const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
after(() => stub.close());
