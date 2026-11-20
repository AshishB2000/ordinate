// Deep research: the write call's report — validation, the per-section audit, caveats, charts only, and the question-5 prose rule.
//   npm run build:ts && node scripts/test-researchWrite.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const W: typeof import('../src/ai/researchWrite') = require('../src/ai/researchWrite');
const { guardAnswer }: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
type Step = import('../src/ai/researchLoop').StepRec;

const step = (n: number, value: number, status: Step['status'] = 'done'): Step => ({ n, kind: 'answer', title: `Step ${n}`, status, spec: {}, facts: `f${n}`, ledger: status === 'done' ? [{ label: 'x', value, unit: 'number', source: 't' }] : [] });
const steps = [step(1, 1234), step(2, 98765), step(3, 555, 'failed')];
const NOTE = 'Contains a figure the app did not compute';
const build = (raw: unknown, g = [] as import('../src/ai/numberAudit').LedgerEntry[]) => W.buildReport(raw as Record<string, unknown>, steps, g, guardAnswer, 'now');

const rep = build({
  title: 'West churn', summary: 'Both steps show it: 1234 and 98765.',
  sections: [
    { heading: 'First', text: 'Revenue was 1234 here.', steps: [1] },
    { heading: 'Second', text: 'It was 98765 here but also 1234.', steps: [2, 3, 9, 'x'] },
  ],
  caveats: ['Data is monthly.', 'Churn rose 12.5% somewhere', 'Costs 1,200 more', 'Rose 3 %'], conclusion: 'Done at 1234.',
});
ok('report: built with its sections', !!rep && rep.sections.length === 2 && rep.title === 'West churn');
ok('audit: a figure from the CITED step passes without a note', !!rep && !rep.sections[0].text.includes(NOTE));
ok('audit: a figure from an UNCITED step gets the guard note (1234 belongs to step 1, section 2 cites step 2)', !!rep && rep.sections[1].text.includes(NOTE) && rep.sections[1].text.includes('1234') && !/98765\b[^]*98765/.test(rep.sections[1].text.split(NOTE)[1] ?? ''));
ok('audit: a section citing nothing valid is audited against the guidance ledger only', (build({ sections: [{ heading: 'h', text: 'It is 1234.', steps: [3] }] })?.sections[0].text ?? '').includes(NOTE));
ok('audit (negative control): the same figure passes when the guidance ledger holds it', !(build({ sections: [{ heading: 'h', text: 'It is 1234.', steps: [3] }] }, [{ label: 'g', value: 1234, unit: 'number', source: 'g' }])?.sections[0].text ?? '').includes(NOTE));
ok('audit: the summary and conclusion are audited against ALL done steps', !!rep && !rep.summary.includes(NOTE) && !rep.conclusion.includes(NOTE));
ok('audit: a figure no step computed is flagged in the summary', (build({ summary: 'It was 777777.', sections: [{ heading: 'a', text: 'x', steps: [1] }] })?.summary ?? '').includes(NOTE));
ok('citations: a failed step, an unknown step and a non-number are dropped', !!rep && JSON.stringify(rep.sections[1].steps) === '[2]');
ok('caveats: a figure-like token drops the caveat, a plain one stays', !!rep && JSON.stringify(rep.caveats) === '["Data is monthly."]', JSON.stringify(rep?.caveats));
ok('sections: at most 6', (build({ sections: Array.from({ length: 9 }, (_, i) => ({ heading: `s${i}`, text: 'words', steps: [1] })) })?.sections.length) === 6);
const long = build({ summary: 'a'.repeat(5000), sections: [{ heading: 'h'.repeat(500), text: 'line one\nstill one\n\n\npara   two', steps: [1] }] });
ok('lengths: cut to fixed lengths, paragraphs kept on one line', !!long && long.summary.length === 1200 && long.sections[0].heading.length === 120 && long.sections[0].text === 'line one still one\n\npara two');
ok('empty or unusable replies give no report', build(null) === null && build({}) === null && build({ sections: [{ heading: 'x' }] }) === null && W.parseWriteReply('no json here') === null && W.parseWriteReply('[1]') === null);
ok('parse: a fenced JSON reply is read', W.parseWriteReply('```json\n{"title":"a"}\n```')?.title === 'a');

const co = W.chartsOnly(steps, 'My question', 'now');
ok('failed write: a charts-only report of the done steps, with none of the model\'s words', co.chartsOnly === true && co.sections.length === 2 && co.sections.every((s) => s.text === '') && co.summary === '' && co.conclusion === '');
ok('public step: an SQL step keeps its title only, never its statement', JSON.stringify(W.publicStep({ n: 1, kind: 'sql', title: 'T', status: 'done', spec: { sql: 'SELECT secret FROM x', datasetIds: ['d'], title: 'T' } })) === '{"n":1,"kind":"sql","title":"T","status":"done","spec":{"title":"T"}}');
ok('public step: never its facts, ledger or dataset ids', !/"facts"|"ledger"|datasetIds/.test(JSON.stringify(W.publicStep({ ...steps[0], datasetIds: ['d'] }))));

// The question-5 rule, decided for the whole RUN (the reviewer's q5.js, as a test).
const words = { fixed: 'The full text is in the private report.', fixedCaveats: 'The caveats are in the private report.', written: 'Written on Nov 20, 2026 from the data then', finding: (n: number) => `Finding ${n}` };
const text = (bs: ReturnType<typeof W.storyBlocks>) => bs.flatMap((b) => (b.kind === 'text' || b.kind === 'callout' ? [b.text] : []));
const L = (v: number, label: string) => ({ label, value: v, unit: 'number' as const, source: 'test' });
const q5steps: Step[] = [
  { n: 1, kind: 'answer', title: 'Orders by region', status: 'done', facts: 'x', ledger: [L(500, 'orders')], datasetIds: ['d-open'] },
  { n: 2, kind: 'answer', title: 'Salaries', status: 'done', facts: 'y', ledger: [L(98765, 'top salary')], datasetIds: ['d-hr'] },
];
const reply = {
  title: 'Top salary is 98765', summary: 'Orders were 500 and the top salary was 98765.',
  sections: [{ heading: 'Salary 98765 drives it', text: 'We saw 500 orders; the top salary is 98765.', steps: [1] }, { heading: 'HR', text: 'Top salary 98765.', steps: [2] }],
  caveats: ['Pay bands differ by site.'], conclusion: 'The top salary of 98765 matters.',
};
const q5 = W.buildReport(reply, q5steps, [], guardAnswer, '2026-11-20T00:00:00Z')!;
const QUESTION = 'What do we pay and sell?';
const run = W.storyBlocks(q5, QUESTION, true, words, new Set([1, 2]));
const all = JSON.stringify(run);
ok('Q5 run level: the restricted figure appears nowhere in the Story blocks (summary, section text, heading, title, conclusion)', !all.includes('98765'), all.slice(0, 300));
ok('Q5 run level: an UNCITED restricted step restricts the whole run (the summary that quotes it is a fixed line)', !text(run).some((t) => /Orders were 500/.test(t)) && text(run).filter((t) => t === words.fixed).length === 4, JSON.stringify(text(run)));
ok('Q5 run level: a section citing only OPEN steps keeps no quoted figure either (guardAnswer\'s note leaves the figure in place)', q5.sections[0].text.includes('98765') && !text(run).some((t) => /We saw 500/.test(t)));
ok('Q5 run level: a heading with a figure becomes "Finding n"; a heading without one is kept', text(run).includes('## Finding 1') && text(run).includes('## HR') && !text(run).some((t) => t.includes('Salary 98765')));
ok('Q5 run level: the title with a figure becomes the starter\'s question; the caveats become the fixed line', text(run)[0] === `# ${QUESTION}` && text(run).some((t) => t === `- ${words.fixedCaveats}`) && !text(run).some((t) => /Pay bands/.test(t)));
ok('Q5 run level: every section is still dated', text(run).filter((t) => t === words.written).length === 2);
ok('Q5: a heading with a BARE integer ("West lost 4500 customers") is replaced; FIGURE_RE would have let it through', !W.hasDigit('West lost customers') && W.hasDigit('West lost 4500 customers') && W.sectionHeading('West lost 4500 customers', 0, true, words) === 'Finding 1' && W.storyTitle({ title: 'West lost 4500 customers' }, 'Why did West churn in 2024?', true) === 'Why did West churn in 2024?');
ok('Q5: the title and heading are the model\'s while there is no digit', W.storyTitle({ title: 'Where sales come from' }, QUESTION, true) === 'Where sales come from' && W.sectionHeading('By region', 0, true, words) === 'By region');
const open = W.storyBlocks(q5, QUESTION, false, words, new Set([1, 2]));
ok('Q5 negative control: an all-open run keeps its prose, summary, conclusion, headings and title as written, each section dated', text(open).includes(q5.sections[1].text) && text(open).includes(q5.summary) && text(open).includes(q5.conclusion) && text(open).includes('## HR')
  && text(open)[0] === '# Top salary is 98765' && text(open).some((t) => t === '- Pay bands differ by site.') && text(open).filter((t) => t === words.written).length === 2);
ok('Q5: caveats ride as one warning callout, before a divider and the conclusion', open.some((b) => b.kind === 'callout' && b.tone === 'warning') && open.at(-2)?.kind === 'divider');
ok('Q5: a step that was not saved has no chart block', W.storyBlocks(q5, QUESTION, false, words, new Set([1])).filter((b) => b.kind === 'visual').length === 1);
ok('Q5: the extra caveats (a chart not saved) are the app\'s words and stay in a restricted run', text(W.storyBlocks(q5, QUESTION, true, words, new Set([1]), ['Step 2 could not be saved'])).some((t) => /Step 2 could not be saved/.test(t)));

// An SQL step\'s ledger comes from its ROWS only (the reviewer\'s sqlledger.js).
const P: typeof import('../src/ai/researchPrompts') = require('../src/ai/researchPrompts');
const f = P.sqlFacts({ title: 'Churn rose 47 points to 4500', columns: [{ name: 'region' }, { name: 'n_7731' }], rows: [['West', 12]], rowCount: 1, truncated: false });
ok('SQL ledger: the model-written title and column names put no figure in the ledger', !f.ledger.some((e) => [47, 4500, 7731].includes(e.value)) && f.ledger.some((e) => e.value === 12), f.ledger.map((e) => e.value).join(','));
const sqlSteps: Step[] = [{ n: 1, kind: 'sql', title: 't', status: 'done', facts: f.text, ledger: f.ledger, datasetIds: ['d'] }];
const sqlRep = W.buildReport({ title: 'R', summary: '', sections: [{ heading: 'H', text: 'Churn reached 4500, up 47; 7731 too; West had 12.', steps: [1] }], caveats: [], conclusion: '' }, sqlSteps, [], guardAnswer, 'now')!;
ok('SQL ledger: a section stating the title\'s 4500 and 47 and the column\'s 7731 gets the note; the row\'s 12 is fine', /Contains a figure the app did not compute: 4500, 47, 7731/.test(sqlRep.sections[0].text), sqlRep.sections[0].text);
ok('SQL ledger (negative control): the row figures still vouch for themselves', !W.buildReport({ title: 'R', summary: '', sections: [{ heading: 'H', text: 'West had 12.', steps: [1] }], caveats: [], conclusion: '' }, sqlSteps, [], guardAnswer, 'now')!.sections[0].text.includes('Contains a figure'));
finish();
