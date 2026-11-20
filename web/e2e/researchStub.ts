// The model provider the deep-research e2e talks to (./research.e2e.ts): an Anthropic Messages API look-alike on loopback, in this
// process — no real network call is made. It answers the three research calls from their prompts: the plan, each step (one chart of
// the Sales dataset, then done) and the report, whose figures it reads off the facts the app sent. A question that says "slowly" makes
// the first step take a few seconds, so a spec can press Stop while the run is going.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after } from 'node:test';

export const QUICK = 'Why does revenue differ by region?';
export const SLOW = 'Why does revenue differ by region? Take it slowly.';
export const calls = { plan: 0, step: 0, write: 0 };

const SPEC = { dataset: 'Sales', category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }] };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-stub', display_name: 'Claude Sonnet Stub', created_at: 2 }] }));
        return;
      }
      const json = JSON.parse(body || '{}') as { system?: unknown; messages?: { content: unknown }[] };
      const system = JSON.stringify(json.system ?? '');
      const asked = JSON.stringify(json.messages?.at(-1)?.content ?? '');
      let text = 'OK';
      if (system.includes('Now write the PLAN')) {
        calls.plan += 1;
        text = JSON.stringify({ plan: ['How does revenue split by region?', 'Which region leads?', 'Is the split even?'] });
      } else if (system.includes('Now choose the NEXT step')) {
        calls.step += 1;
        const done = (asked.match(/STEP \d+ \(/g) ?? []).length;
        if (!done && asked.includes('slowly')) await sleep(6000);
        text = done ? '{"kind":"done"}' : JSON.stringify({ kind: 'answer', intent: 'revenue by region', spec: SPEC });
      } else if (system.includes('Now write the REPORT')) {
        calls.write += 1;
        const total = /Total revenue: ([\d.,]+)/.exec(asked)?.[1] ?? '';
        text = JSON.stringify({
          title: 'Where revenue comes from',
          summary: `Revenue was ${total} in total across the regions.`,
          sections: [{ heading: 'By region', text: `Total revenue was ${total}, and the regions are not evenly split.`, steps: [1] }],
          caveats: ['Revenue is the sample file the project holds, not a ledger.'],
          conclusion: 'One chart was enough to answer the question.',
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
    })();
  });
});
await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
export const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
after(() => stub.close());
