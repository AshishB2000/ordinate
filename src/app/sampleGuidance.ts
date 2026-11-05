// The sample project's guidance (semantic layer part 3 D13): three instructions and four verified questions, the set
// CI's replay and the live-model run score the Assistant on (scripts/test-verifiedEval.ts, verified-eval-cases.ts).
//
// Seeded through the doors an editor uses — `changeInstructions`, and `saveVerifiedQuestion`, which draws each
// question once before it is kept. Digit-free but for one "5", so no number in it can be taken for a figure.
// Never throws: a failure is logged, as the metric seed's is, and the sample stands without it.

import type { AnswerFilter, AnswerSpec } from '../ai/answerSpec';
import { changeInstructions } from './instructions';
import { saveVerifiedQuestion } from '../ipc/verified';
import { logger } from './logger';

export const SAMPLE_INSTRUCTIONS = [
  'When someone says sales, they mean the revenue column.',
  'Profit is already net of discount; never subtract the discount again.',
  'Use order_date for any period.',
];

type Seeded = { question: string; phrasings?: string[]; spec: Omit<AnswerSpec, 'datasetId' | 'title' | 'filters'> & { filters?: AnswerFilter[] } };
const sum = (column: string) => [{ column, aggregation: 'sum' as const }];

export const SAMPLE_VERIFIED: Seeded[] = [
  { question: 'Revenue by region', phrasings: ['Sales by region', 'Which region sells the most'], spec: { category: 'region', measures: sum('revenue'), chartType: 'column' } },
  { question: 'Profit by category', phrasings: ['Profit per category'], spec: { category: 'category', measures: sum('profit'), chartType: 'column' } },
  { question: 'Top 5 states by revenue', phrasings: ['Best states by revenue'], spec: { category: 'state', measures: sum('revenue'), chartType: 'column', top: 5 } },
  {
    question: 'Revenue by month last year', phrasings: ['Monthly revenue last year'],
    spec: { category: 'order_date', grain: 'month', measures: sum('revenue'), chartType: 'line', filters: [{ column: 'order_date', period: 'last_year' }] },
  },
];

export async function seedSampleGuidance(projectId: string, datasetId: string): Promise<void> {
  for (const text of SAMPLE_INSTRUCTIONS) {
    await changeInstructions(projectId, { kind: 'add', text }).catch((err: Error) => logger.error('[sample] could not save the instruction', text, err.message));
  }
  for (const v of [...SAMPLE_VERIFIED].reverse()) { // listed newest first: "Revenue by region" leads
    const spec = { filters: [], ...v.spec, datasetId, title: v.question };
    const r = await saveVerifiedQuestion(projectId, { question: v.question, phrasings: v.phrasings, spec }).catch((err: Error) => ({ ok: false as const, error: err.message }));
    if (!r.ok) logger.error('[sample] could not save the verified question', v.question, r.error);
  }
}
