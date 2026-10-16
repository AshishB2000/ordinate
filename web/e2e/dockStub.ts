// The model provider the dock e2e talks to (./dock.e2e.ts): an Anthropic
// Messages API look-alike on loopback, in this process — no real network call
// is made. Importing it starts it; it keeps what it was asked, for the spec to
// read (`lastAsk`, `draftAsk`, `draftCalls`, `askedModels` are live bindings).

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after } from 'node:test';

export const ANSWER = ['This project ', 'has no ', 'datasets yet — ', 'import a file ', 'to start.'];
const PLAN = {
  kind: 'plan',
  intent: 'Import the sales file and track total revenue',
  steps: [
    { kind: 'import', file: 'sales.csv', name: 'Sales' },
    { kind: 'metric', dataset: 'Sales', name: 'Total revenue', column: 'revenue', aggregation: 'sum' },
  ],
};

/** What the model answers a "build me a dashboard" with (the action), and what it then drafts (structure only — no figure). */
const DASHBOARD = '\n@@ACTION {"kind":"dashboard","intent":"revenue by region"}';
const DRAFT = {
  name: 'Regional revenue',
  rationale: 'Revenue split by region, with the total beside it.',
  calculatedFields: [],
  sheets: [{
    name: 'Overview',
    metrics: [{ dataset: 'Sales', column: 'revenue', aggregation: 'sum', label: 'Total revenue' }],
    visuals: [{ dataset: 'Sales', name: 'Revenue by region', chartType: 'column', encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, filters: [] }],
    texts: [],
  }],
};
/** What the model asks back when the draft prompt lets it (the clarify clause) — structure, no figure. */
const QUESTIONS = {
  questions: [
    { ask: 'Which measure matters most?', options: ['Revenue', 'Number of orders'] },
    { ask: 'How should the regions be compared?', options: ['Side by side', 'As a share of the total', 'Ranked'] },
  ],
};
/** What `analysis:draft` asked the model, last. */
export let draftAsk = '';
/** Every draft call, in order: was the model allowed to ask, and the facts it was sent. */
export const draftCalls: { asking: boolean; facts: string }[] = [];

/** The models the stub asked with, in order. */
export const askedModels: string[] = [];
/** The last streamed ask: the app's facts and the question, as the model was sent them. */
export let lastAsk = '';
/** A question about the dashboard on screen, and what the model says to it (words only: a figure would be audited). */
export const ON_SCREEN = 'What is on this dashboard?';
export const ON_SCREEN_ANSWER = ['It has one sheet: ', 'revenue by region, ', 'with the total beside it.'];

/** What the model adds to ANSWER when the project has no data: the dock shows the three ways in. */
const GET_DATA = '\n@@ACTION {"kind":"import","intent":"bring data in"}';

/** A question a chart answers, and the follow-up that continues it: the model's second reply is a REFINE carrying only what changes. */
export const ASK_CHART = 'Revenue by region excluding North';
export const ASK_REFINE = 'now only above 900';
const CHART = `\n@@ACTION ${JSON.stringify({ kind: 'answer', intent: ASK_CHART, spec: { dataset: 'Sales', category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }], filters: [{ column: 'region', op: '!=', value: 'North' }] } })}`;
const REFINE = `\n@@ACTION ${JSON.stringify({ kind: 'answer', intent: `${ASK_CHART}, large orders only`, spec: { refine: true, filters: [{ column: 'revenue', op: '>', value: 900 }] } })}`;

/** A question whose chart the model writes with a name the data does not have ("net revenue" for revenue). */
export const ASK_MISS = 'Total net revenue by region';
const MISS = `\n@@ACTION ${JSON.stringify({ kind: 'answer', intent: ASK_MISS, spec: { dataset: 'Sales', category: 'region', measures: [{ column: 'net revenue', aggregation: 'sum' }] } })}`;

/** The provider stub: lists two models, a connectivity test gets "OK", a draft gets QUESTIONS when its prompt allows them and DRAFT when it does not, a streamed ask gets ANSWER and GET_DATA (or a chart, its refine, a plan or a dashboard proposal when asked for one). */
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-stub', display_name: 'Claude Sonnet Stub', created_at: 2 }, { id: 'claude-haiku-stub', display_name: 'Claude Haiku Stub', created_at: 1 }] }));
      return;
    }
    const json = JSON.parse(body || '{}') as { stream?: boolean; model?: string; system?: unknown; messages?: { content: unknown }[] };
    askedModels.push(String(json.model));
    const asked = JSON.stringify(json.messages?.at(-1)?.content ?? '');
    if (!json.stream) {
      const system = JSON.stringify(json.system ?? '');
      const drafting = system.includes('ANALYSIS PLAN');
      // Only the clarify clause spells the questions shape: the plain draft prompt has no way to ask.
      const asking = drafting && system.includes('\\"questions\\"');
      if (drafting) {
        draftAsk = asked;
        draftCalls.push({ asking, facts: asked });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: asking ? JSON.stringify(QUESTIONS) : drafting ? JSON.stringify(DRAFT) : 'OK' }], stop_reason: 'end_turn' }));
      return;
    }
    lastAsk = asked;
    // ASK_MISS first: a later ask carries the PREVIOUS ANSWER block, whose title may quote ASK_CHART.
    const chart = asked.includes(ASK_MISS) ? ['Here is net revenue by region.', MISS]
      : asked.includes(ASK_REFINE) ? ['Narrowing it down.', REFINE] : asked.includes(ASK_CHART) ? ['Here is revenue by region.', CHART] : null;
    const parts = chart ?? (asked.includes(ON_SCREEN)
      ? ON_SCREEN_ANSWER
      : asked.includes('a plan')
        ? ['Here is a plan you can run step by step.', `\n@@ACTION ${JSON.stringify(PLAN)}`]
        : asked.includes('regional dashboard')
          ? ['I will draft a dashboard of revenue by region.', DASHBOARD]
          : [...ANSWER, GET_DATA]);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const tick = setInterval(() => {
      if (i < parts.length) {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: parts[i++] } })}\n\n`);
        return;
      }
      clearInterval(tick);
      res.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    }, 150);
  });
});
await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
export const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
after(() => stub.close());
