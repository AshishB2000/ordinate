// Knowledge passages in the Assistant's ask (docs/knowledge-docs/00-design.md rules 5-9), through the REAL registered
// `copilot:ask` handler over HTTP on a scratch database (scripts/notifyHarness.ts), the model stubbed at analyze.askCopilot
// (as test-agentAsk.ts), so every word a model was sent is read back. Without DATABASE_URL: one skip line.
//
//   (a) the matching passage reaches the prompt, inside the GUIDANCE fence, under its header; the unmatched one does not;
//       a question nothing matches adds no header — NEGATIVE CONTROL: the matching question carries it
//   (b) an agent's own passages appear only for that agent (not the Project assistant, not another agent); the project's
//       reach every agent
//   (c) the turn records the document ids (never text), the reply and the stored history name them by title, and a
//       document deleted since then comes back as gone
//   (d) a ranking failure is logged and the ask still answers, without passages — NEGATIVE CONTROL: restored, they return
//   (e) the guard: "$4.2M" from a document is no verified figure (the answer gets the note); a plain "30-day" repeated is fine;
//       the same $4.2M with the figure in the facts is not flagged elsewhere (test-knowledgeBlock)
//   (f) the Assistant check (src/ipc/assistantCheck.ts) reads passages as the dock does: its askGuidance gets them
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-knowledgeAsk.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { BOSS, show, withServer } from './notifyHarness';

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const sa: typeof import('../src/ai/suggestedAction') = require('../src/ai/suggestedAction');
const store: typeof import('../src/knowledge/store') = require('../src/knowledge/store');
const guidance: typeof import('../src/ipc/guidance') = require('../src/ipc/guidance');
const H: typeof import('../src/knowledge/passageBlock') = require('../src/knowledge/passageBlock');

withServer('knowledge-ask', {}, async (b) => {
  const must = async (as: string, channel: string, payload: unknown): Promise<any> => { // any: each channel's own reply
    const r = await b.as(as).call(channel, payload);
    if (r.status !== 200) throw new Error(`${channel} as ${as}: ${r.status} ${String(r.text).slice(0, 200)}`);
    return r.body;
  };
  const P: string = await b.run(BOSS, async () => (await projects.createProject('Knowledge ask')).id);
  await b.provision('fay', 'ed');
  await must('boss', 'admin:setRole', { userId: await b.uid('ed'), role: 'editor' });
  await b.share(P, 'fay', 'viewer');
  await b.share(P, 'ed', 'editor');
  const team: string = (await must('boss', 'admin:createTeam', { name: 'Finance' })).id;
  await must('boss', 'admin:teamMember', { teamId: team, userId: await b.uid('fay'), member: true });
  const mkAgent = async (name: string, teamIds: string[]): Promise<string> => (await must('boss', 'agent:save', { projectId: P, agent: { name, topicId: null, model: null, build: false, teamIds } })).agent.id;
  const A = await mkAgent('Finance assistant', [team]);
  const B = await mkAgent('Other assistant', [team]);
  const mk = (title: string, text: string, agent: string | null = null) => b.run(BOSS, () => store.createDoc(P, agent, { title, text }, randomUUID(), 'boss@acme.test'));
  const policy = await mk('Revenue policy', '# Revenue\n\n## Refunds\n\nA refund reduces revenue in the month it is paid out, never the month of the order.\n\n## Active customers\n\nAn active customer paid for an order in the trailing 30-day window. Revenue in 2025 was $4.2M.');
  const handbook = await mk('Office handbook', '# Parking\n\nVisitors park behind the main entrance.');
  const glossary = await mk('Finance glossary', '# Calendar\n\nA fiscal quarter means three months starting in February.', A);

  require('../src/server/rpc'); // handlers are registered by the harness
  const sent: { facts: string; q: string }[] = [];
  const replies: any[] = []; // any: provider replies
  (analyze as any).askCopilot = async (_prior: unknown, facts: string, q: string) => { // any: replacing the provider call
    sent.push({ facts, q });
    return replies.shift() ?? { ok: true, text: 'Fine.', suggestedAction: sa.NO_ACTION };
  };
  (execConfig as any).executionReady = () => true; // any: no model is configured in a self-check
  const ask = (as: string, question: string, extra: object = {}): Promise<any> => must(as, 'copilot:ask', { projectId: P, context: { kind: '' }, question, ...extra });
  const fence = (facts: string): string => facts.slice(facts.indexOf('<<<GUIDANCE'), facts.lastIndexOf('GUIDANCE') + 8);

  // (a)
  const r1 = await ask('ed', 'How do we count refunds?');
  const facts1 = sent.at(-1)!.facts;
  ok('the ask answers', r1.ok === true, show(r1));
  ok('the matching passage is in the prompt, inside the GUIDANCE fence, under its header', fence(facts1).includes(H.DOCUMENTS_HEADER) && fence(facts1).includes('[Revenue policy › Revenue › Refunds] A refund reduces revenue in the month it is paid out'), fence(facts1));
  ok('the unmatched passage is not', !facts1.includes('Visitors park') && !facts1.includes('three months starting'));
  ok('one line per passage', fence(facts1).split('\n').filter((l) => l.startsWith('[')).every((l) => !l.includes('\n')));
  await ask('ed', 'What is the airspeed velocity of a swallow?');
  ok('NEGATIVE CONTROL: a question nothing matches adds no header and no passage', !sent.at(-1)!.facts.includes(H.DOCUMENTS_HEADER) && !sent.at(-1)!.facts.includes('[Revenue policy'));

  // (b)
  await ask('fay', 'What is a fiscal quarter?', { agentId: A });
  ok('the agent\'s own passage reaches that agent', sent.at(-1)!.facts.includes('[Finance glossary › Calendar] A fiscal quarter means three months'));
  await ask('fay', 'How do we count refunds?', { agentId: A, threadId: (await must('fay', 'copilot:newThread', { projectId: P, agentId: A })).thread.id });
  ok('…and the project\'s passages reach it too', sent.at(-1)!.facts.includes('[Revenue policy › Revenue › Refunds]'));
  await ask('ed', 'What is a fiscal quarter?');
  ok('NEGATIVE CONTROL: the Project assistant never gets an agent\'s passage', !sent.at(-1)!.facts.includes('Finance glossary'));
  await ask('fay', 'What is a fiscal quarter?', { agentId: B, threadId: (await must('fay', 'copilot:newThread', { projectId: P, agentId: B })).thread.id });
  ok('another agent does not either', !sent.at(-1)!.facts.includes('Finance glossary'));

  // (c)
  const r2 = await ask('ed', 'How do we count refunds?');
  ok('the reply records the document ids and names them by title', JSON.stringify(r2.guidance.documents) === JSON.stringify([policy.id]) && r2.guidance.documentRefs?.[0]?.title === 'Revenue policy' && !JSON.stringify(r2.guidance).includes('A refund reduces'), show(r2.guidance));
  const history = await must('ed', 'copilot:history', { projectId: P, threadId: r2.threadId });
  const last = history.turns.filter((t: any) => t.role === 'assistant').at(-1); // any: a stored turn
  ok('the stored turn keeps ids only; history names them', last.guidance.documents[0] === policy.id && last.guidance.documentRefs[0].title === 'Revenue policy' && !('gone' in last.guidance.documentRefs[0]));
  await b.run(BOSS, () => store.deleteDoc(P, policy.id));
  const gone = (await must('ed', 'copilot:history', { projectId: P, threadId: r2.threadId })).turns.filter((t: any) => t.role === 'assistant').at(-1); // any: a stored turn
  ok('a document deleted since then comes back as gone', gone.guidance.documentRefs[0].gone === true && gone.guidance.documentRefs[0].title === '');
  const policy2 = await mk('Revenue policy', '# Revenue\n\n## Refunds\n\nA refund reduces revenue in the month it is paid out, never the month of the order.\n\n## Active customers\n\nAn active customer paid for an order in the trailing 30-day window. Revenue in 2025 was $4.2M.');

  // (c2) a person taken off the agent's team no longer sees its documents' titles in their history.
  const rFay = await ask('fay', 'What is a fiscal quarter?', { agentId: A, threadId: (await must('fay', 'copilot:newThread', { projectId: P, agentId: A })).thread.id });
  ok('(setup) Fay\'s answer read the agent\'s document and names it by title', rFay.guidance.documentRefs?.[0]?.title === 'Finance glossary', show(rFay.guidance));
  await must('boss', 'admin:teamMember', { teamId: team, userId: await b.uid('fay'), member: false });
  const fayHist = (await must('fay', 'copilot:history', { projectId: P, threadId: rFay.threadId })).turns.filter((t: any) => t.role === 'assistant').at(-1); // any: a stored turn
  ok('removed from the team: the agent\'s document comes back as gone, with no title', fayHist.guidance.documentRefs[0].gone === true && fayHist.guidance.documentRefs[0].title === '' && !JSON.stringify(fayHist.guidance).includes('Finance glossary'), show(fayHist.guidance));
  const stillEd = (await must('ed', 'copilot:history', { projectId: P, threadId: (await ask('ed', 'How do we count refunds?')).threadId })).turns.filter((t: any) => t.role === 'assistant').at(-1); // any: a stored turn
  ok('NEGATIVE CONTROL: the project\'s own document is still named for everyone', stillEd.guidance.documentRefs[0].title === 'Revenue policy');
  await must('boss', 'admin:teamMember', { teamId: team, userId: await b.uid('fay'), member: true });

  // (d)
  const realCandidates = store.candidates;
  (store as any).candidates = async () => { throw Object.assign(new Error('boom: a document says secret-canary'), { code: 'XX000' }); }; // any: forcing the failure
  const r3 = await ask('ed', 'How do we count refunds?');
  ok('a ranking failure still gives an answer, without passages', r3.ok === true && !sent.at(-1)!.facts.includes(H.DOCUMENTS_HEADER) && r3.guidance.documents === undefined, show(r3));
  ok('…and the failure\'s message (which could quote a document) is not logged', !b.log.join('').includes('secret-canary'));
  (store as any).candidates = realCandidates; // any: restoring
  await ask('ed', 'How do we count refunds?');
  ok('NEGATIVE CONTROL: restored, the passages return', sent.at(-1)!.facts.includes('[Revenue policy › Revenue › Refunds]'));

  // (e)
  replies.push({ ok: true, text: 'Revenue was $4.2M last year.', suggestedAction: sa.NO_ACTION });
  const r4 = await ask('ed', 'What was revenue and who is an active customer?');
  ok('a figure quoted from a document gets the guard\'s note', r4.numberAudit.violations.length > 0 && r4.answer.includes('4.2'), show(r4.numberAudit));
  replies.push({ ok: true, text: 'An active customer paid in the trailing 30-day window.', suggestedAction: sa.NO_ACTION });
  const r5 = await ask('ed', 'Who is an active customer?');
  ok('NEGATIVE CONTROL: a plain number from the document ("30-day") is repeated with no note', r5.numberAudit.violations.length === 0 && r5.answer === 'An active customer paid in the trailing 30-day window.', show(r5));

  // (f)
  const g = await b.run(BOSS, () => guidance.askGuidance(P, { kind: '' }, 'project', 'How do we count refunds?'));
  ok('the Assistant check\'s askGuidance reads passages as the dock does', g.text.includes('[Revenue policy › Revenue › Refunds]') && g.used.documents?.[0] === policy2.id, g.text.slice(0, 300));
  const noQuestion = await b.run(BOSS, () => guidance.askGuidance(P, { kind: '' }, 'project'));
  ok('NEGATIVE CONTROL: with no question (a narration) there are none', !noQuestion.text.includes(H.DOCUMENTS_HEADER));
  void handbook; void glossary;
}).catch((err) => { console.error(err); process.exitCode = 1; }).finally(finish);
