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

// The question-5 rule.
const words = { fixed: 'The full text is in the private report.', written: 'Written on Nov 20, 2026 from the data then' };
const r = rep!;
const open = W.storyBlocks(r, { sections: [false, false], all: false }, words, new Set([1, 2]));
const text = (bs: ReturnType<typeof W.storyBlocks>) => bs.flatMap((b) => (b.kind === 'text' || b.kind === 'callout' ? [b.text] : []));
ok('Q5: open data keeps the prose as written, each section dated', text(open).includes(r.sections[0].text) && text(open).includes(r.summary) && text(open).includes(r.conclusion) && text(open).filter((t) => t === words.written).length === 2);
const closed = W.storyBlocks(r, { sections: [true, true], all: true }, words, new Set([1, 2]));
const ct = text(closed).join('\n');
ok('Q5: a restricted section keeps its heading and chart, its prose becomes the fixed line, no model text and no digit', !ct.includes(r.sections[0].text) && ct.includes('## First') && closed.filter((b) => b.kind === 'visual').length === 2 && !/\d/.test(words.fixed));
ok('Q5: summary and conclusion follow the rule over all cited steps', !ct.includes(r.summary) && !ct.includes(r.conclusion) && text(closed).filter((t) => t === words.fixed).length === 4, JSON.stringify(text(closed)));
ok('Q5: a section the flags do not cover is treated as restricted (fail closed)', !text(W.storyBlocks(r, { sections: [], all: false }, words, new Set([1]))).includes(r.sections[0].text));
ok('Q5: caveats ride as one warning callout, before a divider and the conclusion', open.some((b) => b.kind === 'callout' && b.tone === 'warning') && open.at(-2)?.kind === 'divider');
ok('Q5: a step that was not saved has no chart block', W.storyBlocks(r, { sections: [false, false], all: false }, words, new Set([1])).filter((b) => b.kind === 'visual').length === 1);
finish();
