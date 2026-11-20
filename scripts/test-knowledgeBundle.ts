// Knowledge documents travel in a project export, a backup and their import (docs/knowledge-docs/00-design.md, "Lifecycle"),
// on the real app over a scratch database (scripts/notifyHarness.ts). Without DATABASE_URL: one skip line.
//
//   (a) export: the project's documents and its agents' are entries `knowledge/<id>.json`, counted in the manifest; the
//       text is in them, and no other project's
//   (b) delete + restore: deleting the project forgets its documents; importing the export brings them back, an agent's
//       document on that agent (same id: nothing collides)
//   (c) import while the original still exists (every id collides and is remapped): the agent's document lands on the NEW
//       agent's id, and the original's documents are untouched
//   (d) a trashed agent's documents do not travel (the Trash is not exported); a document naming an agent the bundle lacks
//       is skipped; a bundle that holds a hand-made unreadable entry still imports
//   (e) without a database: no entries are written, and an import skips them
// NEGATIVE CONTROLS: a project with no documents exports none; the manifest counts match the entries.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-knowledgeBundle.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { BOSS, show, withServer } from './notifyHarness';

const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const store: typeof import('../src/knowledge/store') = require('../src/knowledge/store');
const inOrgMod: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');

withServer('knowledge-bundle', {}, async (b) => {
  const run = <T>(fn: () => Promise<T>): Promise<T> => b.run(BOSS, fn);
  const P: string = await run(async () => (await projects.createProject('Bundle docs')).id);
  const Other: string = await run(async () => (await projects.createProject('Not exported')).id);
  const agent = await run(async () => (await agents.saveAgent(P, { name: 'Finance', topicId: null, model: null, build: false, teamIds: [] }))!);
  const dead = await run(async () => (await agents.saveAgent(P, { name: 'Trashed one', topicId: null, model: null, build: false, teamIds: [] }))!);
  const mk = (project: string, title: string, text: string, a: string | null = null) => run(() => store.createDoc(project, a, { title, text, source: 'pdf', fileName: `${title}.pdf` }, randomUUID(), 'priya@acme.test'));
  const d1 = await mk(P, 'Revenue policy', '# Revenue\n\nNet of refunds.');
  const d2 = await mk(P, 'Finance glossary', 'A fiscal quarter is three months.', agent.id);
  const d3 = await mk(P, 'Trashed agent doc', 'never travels', dead.id);
  await mk(Other, 'Someone else', 'not in this export');
  await run(() => trash.trashRecord(P, 'agent', dead.id));
  void d3;

  // (a)
  const out = (await run(() => bundle.exportProject(P)))!;
  const entries = bundle.readZip(out.bytes);
  const docEntries = entries.filter((e) => e.name.startsWith('knowledge/'));
  ok('the export holds the project\'s and the live agent\'s documents, not the trashed agent\'s or another project\'s', docEntries.length === 2 && docEntries.every((e) => !e.data.toString().includes('never travels') && !e.data.toString().includes('not in this export')), docEntries.map((e) => e.name).join());
  ok('…each with its text, kind, file name and agent', docEntries.some((e) => { const j = JSON.parse(e.data.toString()); return j.title === 'Revenue policy' && j.text.includes('Net of refunds') && j.source === 'pdf' && j.fileName === 'Revenue policy.pdf' && j.agentId === null; }) && docEntries.some((e) => JSON.parse(e.data.toString()).agentId === agent.id));
  ok('the manifest counts them (and the import checks the counts)', out.manifest.counts.knowledge === 2 && out.manifest.counts.agents === 1, show(out.manifest.counts));
  const empty: string = await run(async () => (await projects.createProject('No docs')).id);
  ok('NEGATIVE CONTROL: a project with no documents exports none and counts none', (await run(async () => bundle.readZip((await bundle.exportProject(empty))!.bytes))).every((e) => !e.name.startsWith('knowledge/')) && !('knowledge' in (await run(async () => (await bundle.exportProject(empty))!.manifest.counts))));

  // (c) import while the original exists: ids collide and are remapped
  const copy = await run(() => bundle.importBundle(out.bytes, { name: 'Copy' }));
  ok('import beside the original succeeds', copy.ok === true, show(copy));
  const copyId = copy.ok && copy.project ? copy.project.id : '';
  const copyAgents = await run(() => agents.listAgents(copyId));
  const copyDocs = await run(() => store.allDocs(copyId));
  ok('the documents are in the copy: two, with their text and metadata', copyDocs.length === 2 && copyDocs.some((d) => d.title === 'Revenue policy' && d.source === 'pdf' && d.fileName === 'Revenue policy.pdf' && d.text.includes('Net of refunds') && d.agentId === null), show(copyDocs.map((d) => d.title)));
  ok('the agent\'s document is on the copy\'s NEW agent id, not the original\'s', copyAgents.length === 1 && copyAgents[0].id !== agent.id && copyDocs.find((d) => d.title === 'Finance glossary')?.agentId === copyAgents[0].id, show([copyAgents.map((a) => a.id), copyDocs.map((d) => d.agentId)]));
  ok('the original\'s documents are untouched', (await run(() => store.listDocs(P, null))).length === 1 && (await run(() => store.listDocs(P, agent.id))).length === 1 && (await run(() => store.getDoc(P, d1.id)))?.text.includes('Net of refunds') === true && !!(await run(() => store.getDoc(P, d2.id))));

  // (b) delete + restore
  await run(() => projects.deleteProject(P));
  ok('(setup) deleting the project forgot its documents', (await run(() => store.allDocs(P))).length === 0);
  const restored = await run(() => bundle.importBundle(out.bytes, { name: 'Restored' }));
  const rid = restored.ok && restored.project ? restored.project.id : '';
  const rdocs = await run(() => store.allDocs(rid));
  const ragents = await run(() => agents.listAgents(rid));
  ok('a restore (an import into a new project) brings the documents back, the agent\'s on that agent (its id free again)', restored.ok === true && rdocs.length === 2 && ragents.length === 1 && rdocs.find((d) => d.title === 'Finance glossary')?.agentId === ragents[0].id && ragents[0].id === agent.id, show(restored));

  // (d) a hand-made bundle
  const stray = bundle.writeZip([
    ...entries.filter((e) => !e.name.startsWith('knowledge/') && e.name !== 'manifest.json'),
    { name: `knowledge/${randomUUID()}.json`, data: Buffer.from('{ not json') },
    { name: `knowledge/${randomUUID()}.json`, data: Buffer.from(JSON.stringify({ id: randomUUID(), agentId: randomUUID(), title: 'Orphan of an agent the bundle lacks', text: 'x' })) },
    { name: `knowledge/${randomUUID()}.json`, data: Buffer.from(JSON.stringify({ id: randomUUID(), agentId: null, title: 'Fine one', text: 'kept' })) },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...JSON.parse(entries.find((e) => e.name === 'manifest.json')!.data.toString()), counts: { ...out.manifest.counts, knowledge: 3 } })) },
  ]);
  const hand = await run(() => bundle.importBundle(stray, { name: 'Hand made' }));
  const hdocs = hand.ok && hand.project ? await run(() => store.allDocs((hand.project as { id: string }).id)) : [];
  ok('a document that is unreadable, or names an agent the bundle lacks, is skipped; the fine one lands; the import still succeeds', hand.ok === true && hdocs.length === 1 && hdocs[0].title === 'Fine one', show(hand.ok ? hdocs.map((d) => d.title) : hand));

  // (f) hostile entries: oversized (past the 2 MiB knowledge cap), too many values, a non-string agent id
  const base = entries.filter((e) => !e.name.startsWith('knowledge/') && e.name !== 'manifest.json');
  const manifestWith = (n: number) => ({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...JSON.parse(entries.find((e) => e.name === 'manifest.json')!.data.toString()), counts: { ...out.manifest.counts, knowledge: n } })) });
  const entryOf = (data: Buffer) => ({ name: `knowledge/${randomUUID()}.json`, data });
  const fine = entryOf(Buffer.from(JSON.stringify({ id: randomUUID(), agentId: null, title: 'Fine', text: 'kept' })));
  const big = await run(() => bundle.importBundle(bundle.writeZip([...base, entryOf(Buffer.from(JSON.stringify({ id: randomUUID(), agentId: null, title: 'Big', text: 'a'.repeat(2.2 * 1024 * 1024) }))), manifestWith(1)]), { name: 'Oversized' }));
  ok('an entry over the 2 MiB knowledge cap is refused by the reader: the import fails cleanly, nothing is left', big.ok === false && !(await run(() => projects.listProjects())).some((p) => p.name === 'Oversized'), show(big));
  const nested = '['.repeat(1_000_001) + ']'.repeat(1_000_001); // 2,000,002 bytes: inside the cap, past the value budget
  const deep = await run(() => bundle.importBundle(bundle.writeZip([...base, entryOf(Buffer.from(nested)), fine, manifestWith(2)]), { name: 'Deep' }));
  const deepDocs = deep.ok && deep.project ? await run(() => store.allDocs((deep.project as { id: string }).id)) : [];
  ok('an entry holding more values than the budget is skipped, never parsed; the fine one lands', deep.ok === true && deepDocs.length === 1 && deepDocs[0].title === 'Fine', show(deep.ok ? deepDocs.map((d) => d.title) : deep));
  const odd = await run(() => bundle.importBundle(bundle.writeZip([...base, entryOf(Buffer.from(JSON.stringify({ id: randomUUID(), agentId: 123, title: 'Numeric agent', text: 'x' }))), entryOf(Buffer.from(JSON.stringify({ id: randomUUID(), agentId: { a: 1 }, title: 'Object agent', text: 'x' }))), fine, manifestWith(3)]), { name: 'Odd agent' }));
  const oddDocs = odd.ok && odd.project ? await run(() => store.allDocs((odd.project as { id: string }).id)) : [];
  ok('a non-string agentId (123, an object) drops the entry: it never becomes a project-wide document', odd.ok === true && oddDocs.length === 1 && oddDocs[0].title === 'Fine', show(odd.ok ? oddDocs.map((d) => d.title) : odd));
  const untitled = await run(() => bundle.importBundle(bundle.writeZip([...base, entryOf(Buffer.from(JSON.stringify({ id: randomUUID(), agentId: null, title: '   ', text: 'x' }))), manifestWith(1)]), { name: 'Untitled' }));
  const udocs = untitled.ok && untitled.project ? await run(() => store.allDocs((untitled.project as { id: string }).id)) : [];
  ok('NEGATIVE CONTROL: a blank title is "Untitled document" and the importer is the author when the bundle names none', untitled.ok === true && udocs[0]?.title === 'Untitled document' && udocs[0]?.updatedBy === 'boss@acme.test', show(udocs.map((d) => [d.title, d.updatedBy])));

  // (e) no database
  inOrgMod.useOrgDb(null);
  const noDb = await run(() => bundle.exportProject(Other));
  ok('without a database: nothing is exported', noDb !== null && bundle.readZip(noDb.bytes).every((e) => !e.name.startsWith('knowledge/')));
  const skipped = await run(() => bundle.importBundle(out.bytes, { name: 'No database' }));
  inOrgMod.useOrgDb(b.pool);
  ok('…and an import skips the entries instead of failing', skipped.ok === true && (await run(() => store.allDocs(skipped.ok && skipped.project ? skipped.project.id : ''))).length === 0, show(skipped));
}).catch((err) => { console.error(err); process.exitCode = 1; }).finally(finish);
