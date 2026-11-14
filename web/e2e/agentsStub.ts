// The model provider the agents e2e talks to (./agents.e2e.ts): an Anthropic Messages API look-alike on loopback, in
// this process — no real network call is made. Importing it starts it. It keeps every streamed ask (`asks`, a live
// binding): the system prompt the app chose and the facts it sent, so the spec can read who was asked and how.
//
// An ask whose system prompt is an agent's with a topic ("answers from its topic alone") and whose question is about
// revenue says it is outside, the way the prompt tells it to; any other question about revenue is a chart of Orders.
// Words only: a figure would be audited.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after } from 'node:test';

export const REVENUE_Q = 'What was revenue by region?';
export const OUTSIDE_SAID = 'That is not in the Finance data.';
export const CHART_SAID = 'Here is revenue by region.';
const CHART = `\n@@ACTION ${JSON.stringify({ kind: 'answer', intent: 'revenue by region', spec: { dataset: 'Orders', category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }] } })}`;
const OUTSIDE = '\n@@ACTION {"kind":"outside","intent":"revenue by region"}';

/** Every streamed ask, in order. */
export const asks: { system: string; asked: string; model: string }[] = [];

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-stub', display_name: 'Claude Sonnet Stub', created_at: 2 }] }));
      return;
    }
    const json = JSON.parse(body || '{}') as { stream?: boolean; model?: string; system?: unknown; messages?: { content: unknown }[] };
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
      return;
    }
    const system = JSON.stringify(json.system ?? '');
    const asked = JSON.stringify(json.messages?.at(-1)?.content ?? '');
    asks.push({ system, asked, model: String(json.model) });
    const revenue = asked.includes(REVENUE_Q);
    const parts = revenue && system.includes('answers from its topic alone') ? [OUTSIDE_SAID, OUTSIDE] : revenue ? [CHART_SAID, CHART] : ['Payroll is ', 'in the Payroll data.'];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const text of parts) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
    res.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
  });
});
await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
export const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
after(() => stub.close());
