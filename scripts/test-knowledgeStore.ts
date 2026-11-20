// Knowledge documents at rest (0042_knowledge.sql, docs/knowledge-docs/00-design.md "Storage" and "Lifecycle"), on the real
// app over a scratch database (scripts/notifyHarness.ts). Without DATABASE_URL: one skip line.
//
//   (a) save: a document and its passages in one transaction; the passages carry the word lists and `words`; an edit
//       rewrites them; the edit tag refuses a stale base untouched — NEGATIVE CONTROL: the current base, and no base, save
//   (b) atomic: a passage that cannot be written leaves no document row — NEGATIVE CONTROL: the next save lands
//   (c) delete takes the passages with it; the 100 cap counts a project's agent documents too and frees on a delete; 300,000
//       characters are refused (never cut) and exactly that many are kept; an empty or over-long title is refused
//   (d) row-level security FORCED, as an ORDINARY role: no setting, no row; another org's rows are never seen; a write
//       for another org is refused; the store works through that role
//   (e) lifecycle: an agent purged for good takes its documents, a trashed one keeps them (and they still count); a deleted
//       project takes all of its; the sweep (a `missing_since` column, a day's grace, an injected clock) removes a gone
//       project's or agent's documents only when DEFINITELY missing: a corrupt record or a failed lookup deletes nothing,
//       found-again clears the stamp — NEGATIVE CONTROL: a live project's and a trashed agent's survive
//   (f) the migration: 0042 applied, in order after 0041 (Slack)
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-knowledgeStore.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { BOSS, ORG, ordinaryRole, refusedAs, seenAs, show, withServer } from './notifyHarness';

const store: typeof import('../src/knowledge/store') = require('../src/knowledge/store');
const lifecycle: typeof import('../src/knowledge/lifecycle') = require('../src/knowledge/lifecycle');
const inOrgMod: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const limits: typeof import('../src/knowledge/limits') = require('../src/knowledge/limits');

withServer('knowledge-store', {}, async (b) => {
  const run = <T>(fn: () => Promise<T>): Promise<T> => b.run(BOSS, fn);
  const count = async (table: string, where = 'true'): Promise<number> => Number((await b.pool.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n);
  const P: string = await run(async () => (await projects.createProject('Knowledge store')).id);
  const mk = (title: string, text: string, agent: string | null = null, project = P) => run(() => store.createDoc(project, agent, { title, text }, randomUUID(), 'boss@acme.test'));

  // (a) save
  const d1 = await mk('Revenue policy', '# Revenue\n\nNet of refunds.\n\n## Refunds\n\nPaid out later.');
  ok('createDoc: stored, typed, with its text and a tag', d1.source === 'typed' && d1.fileName === null && d1.text.includes('Net of refunds') && d1.chars === d1.text.length && d1.tag.length > 20 && d1.createdBy === 'boss@acme.test', show(d1));
  const rows = (await b.pool.query('SELECT ord, heading, title_words, heading_words, text_words, words FROM knowledge_passages WHERE doc_id = $1 ORDER BY ord', [d1.id])).rows;
  ok('…and its passages in the same transaction, with heading paths', rows.length === 2 && rows[0].heading === 'Revenue' && rows[1].heading === 'Revenue › Refunds', show(rows));
  ok('…whose `words` is the union of title, heading and text words', rows[1].words.includes('revenue') && rows[1].words.includes('refund') && rows[1].words.includes('paid') && rows[1].title_words.includes('policy') && rows[1].heading_words.includes('refund') && rows[1].text_words.includes('later'), show(rows[1]));
  ok('…and a passage found by its TITLE alone is a candidate', (await run(() => store.candidates(P, null, 'policy'))).length === 2);
  ok('listDocs: no text in the list, newest edit first', (await run(() => store.listDocs(P, null))).every((d) => !('text' in d)) && (await run(() => store.listDocs(P, null)))[0].id === d1.id);

  const stale = d1.tag;
  const d2 = (await run(() => store.updateDoc(P, d1.id, { title: 'Revenue policy', text: '# Revenue\n\nGross of nothing; zebra.' }, stale, 'ed@acme.test')))!;
  ok('updateDoc with the current base: saved, tag moved, passages rewritten', d2.tag !== stale && d2.updatedBy === 'ed@acme.test' && d2.createdBy === 'boss@acme.test' && (await count('knowledge_passages', `doc_id = '${d1.id}'`)) === 1 && (await run(() => store.candidates(P, null, 'zebra'))).length === 1 && (await run(() => store.candidates(P, null, 'refunds'))).length === 0, show(d2));
  let refused: { code?: string; tag?: string } | null = null;
  await run(() => store.updateDoc(P, d1.id, { title: 'Lost', text: 'stale text' }, stale, 'x')).catch((e) => { refused = e; });
  ok('a STALE base is refused untouched (ERECORDCHANGED with the current tag)', (refused as { code?: string } | null)?.code === 'ERECORDCHANGED' && (refused as { tag?: string } | null)?.tag === d2.tag && (await run(() => store.getDoc(P, d1.id)))!.title === 'Revenue policy');
  const d3 = (await run(() => store.updateDoc(P, d1.id, { title: 'Revenue policy v3', text: 'Third text.' }, undefined, 'x')))!;
  ok('NEGATIVE CONTROL: no base is last-writer-wins', d3.title === 'Revenue policy v3' && d3.text === 'Third text.');
  ok('an edit of a document that is not there is null; an id from another project finds nothing', (await run(() => store.updateDoc(P, randomUUID(), { title: 't', text: 'x' }, undefined, 'x'))) === null && (await run(() => store.getDoc(randomUUID(), d1.id))) === null);

  // (b) atomic
  await b.pool.query(`CREATE FUNCTION knowledge_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF 'boom' = ANY (NEW.title_words) THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
  await b.pool.query('CREATE TRIGGER knowledge_boom BEFORE INSERT ON knowledge_passages FOR EACH ROW EXECUTE FUNCTION knowledge_boom()');
  const before = await count('knowledge_docs');
  const failed = await mk('Boom', 'some text').then(() => false, () => true);
  ok('a passage that cannot be written leaves NO document row', failed && (await count('knowledge_docs')) === before);
  const failedEdit = await run(() => store.updateDoc(P, d1.id, { title: 'Boom', text: 'changed text' }, undefined, 'x')).then(() => false, () => true);
  ok('…and an edit that fails leaves the old text and passages', failedEdit && (await run(() => store.getDoc(P, d1.id)))!.text === 'Third text.' && (await count('knowledge_passages', `doc_id = '${d1.id}'`)) === 1);
  await b.pool.query('DROP TRIGGER knowledge_boom ON knowledge_passages');
  ok('NEGATIVE CONTROL: without the fault the same save lands', !!(await mk('Boom', 'some text')));

  // (c) delete, caps
  ok('deleteDoc: the document and its passages are gone', (await run(() => store.deleteDoc(P, d1.id))) === true && (await count('knowledge_passages', `doc_id = '${d1.id}'`)) === 0 && (await run(() => store.getDoc(P, d1.id))) === null && (await run(() => store.deleteDoc(P, d1.id))) === false);
  const P2: string = await run(async () => (await projects.createProject('Cap')).id);
  const A = randomUUID();
  const have = await run(() => store.countDocs(P2));
  // 99 project documents and an agent's one: the cap counts both.
  await b.pool.query(`INSERT INTO knowledge_docs (org_id, project_id, id, agent_id, title, source, chars, text, text_hash, created_by, updated_by)
    SELECT $1, $2, gen_random_uuid(), CASE WHEN g = 1 THEN $3::uuid END, 't' || g, 'typed', 1, 'x', 'h', 'u', 'u' FROM generate_series(1, 99) g`, [ORG, P2, A]);
  ok('(setup) 99 documents, one an agent\'s', have === 0 && (await run(() => store.countDocs(P2))) === 99);
  const hundredth = await mk('The hundredth', 'fits', null, P2);
  ok('the 100th is stored', !!hundredth && (await run(() => store.countDocs(P2))) === 100);
  const over = await mk('The 101st', 'refused', A, P2).then(() => null, (e: Error & { code?: string }) => e);
  ok('the 101st (an agent\'s) is refused with its sentence', over instanceof store.KnowledgeRefusal && over.code === 'full' && /at most 100 documents/.test(over.message), String(over));
  await run(() => store.deleteDoc(P2, hundredth.id));
  ok('NEGATIVE CONTROL: a delete frees a place', !!(await mk('Again', 'fits', A, P2)));
  const big = 'a'.repeat(limits.MAX_TEXT_CHARS);
  ok('300,000 characters are kept whole', (await mk('Big', big, null, P)).chars === limits.MAX_TEXT_CHARS);
  const tooLong = await mk('Longer', big + 'a').then(() => null, (e: Error & { code?: string }) => e);
  ok('300,001 are refused with a message, never cut', tooLong instanceof store.KnowledgeRefusal && tooLong.code === 'tooLong' && /300,000/.test(tooLong.message));
  const noTitle = await mk('   ', 'x').then(() => null, (e: Error & { code?: string }) => e);
  const longTitle = await mk('t'.repeat(121), 'x').then(() => null, (e: Error & { code?: string }) => e);
  const noText = await mk('Empty', ' \n ').then(() => null, (e: Error & { code?: string }) => e);
  ok('an empty title, a 121-character title and an empty text are refused', noTitle?.code === 'title' && longTitle?.code === 'title' && noText?.code === 'text');
  ok('NEGATIVE CONTROL: 120 characters is a fine title', (await mk('t'.repeat(120), 'x')).title.length === 120);

  // (d) RLS as an ordinary role
  await b.pool.query(`INSERT INTO knowledge_docs (org_id, project_id, id, title, source, chars, text, text_hash, created_by, updated_by) VALUES ('other', $1, $2, 'Theirs', 'typed', 1, 'x', 'h', 'u', 'u')`, [P, randomUUID()]);
  const theirs = (await b.pool.query(`SELECT id FROM knowledge_docs WHERE org_id = 'other'`)).rows[0].id;
  await b.pool.query(`INSERT INTO knowledge_passages (org_id, project_id, doc_id, ord, title_words, heading_words, text_words, heading, text, words) VALUES ('other', $1, $2, 0, '{theirs}', '{}', '{}', '', 'x', '{theirs}')`, [P, theirs]);
  const role = await ordinaryRole(b, ['knowledge_docs', 'knowledge_passages']);
  for (const t of ['knowledge_docs', 'knowledge_passages']) {
    ok(`${t}: (control) the superuser sees both orgs`, (await count(t, `org_id = 'other'`)) > 0 && (await count(t, `org_id = '${ORG}'`)) > 0);
    ok(`${t}: an ordinary role with NO org setting sees no row`, (await seenAs(role, t, null)).length === 0);
    ok(`${t}: the org's setting sees only the org's rows`, (await seenAs(role, t, ORG)).length > 0 && (await seenAs(role, t, ORG)).every((r) => r.org_id === ORG));
    ok(`${t}: another org sees only its own`, (await seenAs(role, t, 'other')).length > 0 && (await seenAs(role, t, 'other')).every((r) => r.org_id === 'other'));
  }
  ok('a doc written for ANOTHER org under this org\'s setting is refused', await refusedAs(role, ORG, `INSERT INTO knowledge_docs (org_id, project_id, id, title, source, chars, text, text_hash, created_by, updated_by) VALUES ('other', $1, $2, 't', 'typed', 1, 'x', 'h', 'u', 'u')`, [P, randomUUID()]));
  ok('…and a passage likewise', await refusedAs(role, ORG, `INSERT INTO knowledge_passages (org_id, project_id, doc_id, ord, title_words, heading_words, text_words, heading, text, words) VALUES ('other', $1, $2, 0, '{}', '{}', '{}', '', 'x', '{}')`, [P, theirs]));
  inOrgMod.useOrgDb(role);
  const viaRole = await mk('Through the ordinary role', 'Works as an ordinary role: zebra stripes.');
  ok('the store works through the ordinary role, and never sees another org\'s document', !!viaRole && (await run(() => store.getDoc(P, viaRole.id)))?.title === 'Through the ordinary role' && (await run(() => store.getDoc(P, theirs))) === null && (await run(() => store.candidates(P, null, 'theirs'))).length === 0);
  ok('and a delete does not touch another org\'s rows', (await run(() => store.deleteDoc(P, theirs))) === false && (await count('knowledge_docs', `id = '${theirs}'`)) === 1);
  inOrgMod.useOrgDb(b.pool);
  await role.end();

  // (e) lifecycle
  const P3: string = await run(async () => (await projects.createProject('Lifecycle')).id);
  const agentA = randomUUID();
  const agentB = randomUUID();
  await mk('A one', 'alpha text', agentA, P3);
  await mk('A two', 'alpha text again', agentA, P3);
  await mk('B one', 'beta text', agentB, P3);
  await mk('Project one', 'project text', null, P3);
  await run(() => lifecycle.forgetAgents(P3, [agentA]));
  ok('forgetAgents: that agent\'s documents and their passages are gone, nobody else\'s', (await count('knowledge_docs', `project_id = '${P3}' AND agent_id = '${agentA}'`)) === 0 && (await count('knowledge_passages', `project_id = '${P3}' AND agent_id = '${agentA}'`)) === 0 && (await count('knowledge_docs', `project_id = '${P3}'`)) === 2);
  await run(() => lifecycle.forgetProject(P3));
  ok('forgetProject: all of the project\'s documents and passages, no other project\'s', (await count('knowledge_docs', `project_id = '${P3}'`)) === 0 && (await count('knowledge_passages', `project_id = '${P3}'`)) === 0 && (await count('knowledge_docs', `project_id = '${P}'`)) > 0);

  // …through the real purge and the real project delete.
  const agent = await run(async () => (await (require('../src/ai/agents') as typeof import('../src/ai/agents')).saveAgent(P, { name: 'Purge me', topicId: null, model: null, build: false, teamIds: [] }))!);
  await mk('Agent doc', 'kept while trashed', agent.id, P);
  await run(() => trash.trashRecord(P, 'agent', agent.id));
  ok('an agent in the Trash: its documents stay, listed by no one, still counted', (await count('knowledge_docs', `agent_id = '${agent.id}'`)) === 1);
  await run(() => trash.purge(P, 'agent', agent.id));
  ok('purged for good: its documents and passages are deleted', (await count('knowledge_docs', `agent_id = '${agent.id}'`)) === 0 && (await count('knowledge_passages', `agent_id = '${agent.id}'`)) === 0);
  const agent2 = await run(async () => (await (require('../src/ai/agents') as typeof import('../src/ai/agents')).saveAgent(P, { name: 'Empty me', topicId: null, model: null, build: false, teamIds: [] }))!);
  await mk('Agent doc 2', 'x', agent2.id, P);
  await run(() => trash.trashRecord(P, 'agent', agent2.id));
  await run(() => trash.empty(P));
  ok('"Empty trash" takes them too', (await count('knowledge_docs', `agent_id = '${agent2.id}'`)) === 0);
  const P4: string = await run(async () => (await projects.createProject('Doomed')).id);
  await mk('Doomed doc', 'x', null, P4);
  await run(() => projects.deleteProject(P4));
  ok('a deleted project takes its documents with it', (await count('knowledge_docs', `project_id = '${P4}'`)) === 0 && (await count('knowledge_passages', `project_id = '${P4}'`)) === 0);

  // the sweep: a column (`missing_since`), a day's grace, an injected clock; a read that failed or a corrupt record is "unknown"
  const H = 3_600_000;
  const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
  const GONE = randomUUID();
  await mk('Orphan of a gone project', 'x', null, GONE);
  const live = await mk('Live project doc', 'x', null, P);
  const trashedAgent = await run(async () => (await (require('../src/ai/agents') as typeof import('../src/ai/agents')).saveAgent(P, { name: 'Trashed', topicId: null, model: null, build: false, teamIds: [] }))!);
  const keep = await mk('Trashed agent doc', 'x', trashedAgent.id, P);
  await run(() => trash.trashRecord(P, 'agent', trashedAgent.id));
  const ghostAgent = randomUUID();
  const ghost = await mk('Ghost agent doc', 'x', ghostAgent, P);
  const stamp = async (id: string): Promise<string | null> => (await b.pool.query('SELECT missing_since FROM knowledge_docs WHERE id = $1', [id])).rows[0]?.missing_since ?? null;
  const goneId = (await b.pool.query(`SELECT id FROM knowledge_docs WHERE project_id = $1`, [GONE])).rows[0].id;
  const sweepAt = (t: number) => run(() => lifecycle.sweep(lifecycle.realExists(), t));
  ok('sweep, first look: a definitely missing project and agent are STAMPED, nothing is deleted', (await sweepAt(T0)) === 0 && (await stamp(goneId)) !== null && (await stamp(ghost.id)) !== null && (await count('knowledge_docs', `id = '${ghost.id}'`)) === 1);
  ok('NEGATIVE CONTROL: a live project\'s document and a trashed agent\'s are never stamped', (await stamp(live.id)) === null && (await stamp(keep.id)) === null);
  ok('23 hours later: still there', (await sweepAt(T0 + 23 * H)) === 0 && (await count('knowledge_docs', `project_id = '${GONE}'`)) === 1);
  const gone24 = await sweepAt(T0 + 25 * H);
  ok('25 hours after the first look: the gone project\'s and every ghost agent\'s documents (and passages) go', gone24 === 4 && (await count('knowledge_docs', `project_id = '${GONE}'`)) === 0 && (await count('knowledge_docs', `id = '${ghost.id}'`)) === 0 && (await count('knowledge_passages', `doc_id = '${ghost.id}'`)) === 0 && (await count('knowledge_docs', `agent_id = '${A}'`)) === 0, String(gone24));
  ok('NEGATIVE CONTROL: the live project\'s document and the trashed agent\'s survive', (await count('knowledge_docs', `id = '${live.id}'`)) === 1 && (await count('knowledge_docs', `id = '${keep.id}'`)) === 1);

  // Found again clears the stamp, and the day starts over.
  const flap = await mk('Flapping owner', 'x', null, randomUUID());
  const sees = (f: 'found' | 'missing' | 'unknown') => ({ project: async () => f, agent: async () => f });
  await run(() => lifecycle.sweep(sees('missing'), T0));
  ok('(setup) stamped', (await stamp(flap.id)) !== null);
  await run(() => lifecycle.sweep(sees('found'), T0 + 10 * H));
  ok('found again: the stamp is cleared', (await stamp(flap.id)) === null);
  await run(() => lifecycle.sweep(sees('missing'), T0 + 30 * H));
  ok('missing again 30 h after the FIRST look: stamped afresh, not deleted (the day restarted)', (await stamp(flap.id)) !== null && (await count('knowledge_docs', `id = '${flap.id}'`)) === 1);
  await run(() => lifecycle.sweep(sees('unknown'), T0 + 90 * H));
  ok('a lookup that FAILED never deletes and never stamps, however late', (await count('knowledge_docs', `id = '${flap.id}'`)) === 1);
  const thrower = { project: async () => { throw new Error('db down'); }, agent: async () => 'found' as const };
  await run(() => lifecycle.sweep(thrower, T0 + 100 * H));
  ok('a lookup that THROWS is unknown too', (await count('knowledge_docs', `id = '${flap.id}'`)) === 1);
  await run(() => lifecycle.sweep(sees('missing'), T0 + 100 * H + 25 * H));
  ok('NEGATIVE CONTROL: definitely missing, more than a day after its stamp: deleted', (await count('knowledge_docs', `id = '${flap.id}'`)) === 0);

  // A CORRUPT project record (the real lookups) deletes nothing, however many passes and however late.
  const PC: string = await run(async () => (await projects.createProject('Corrupt record')).id);
  const cdoc = await mk('In a project with a bad record', 'x', null, PC);
  const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
  const kinds: typeof import('../src/app/recordKinds') = require('../src/app/recordKinds');
  const projectFile = await run(async () => (require('path') as typeof import('path')).join(kinds.projectDir(PC), 'project.json'));
  await run(() => recordFs.writeFile(projectFile, '{ this is not json', 'utf8'));
  for (const h of [0, 30, 60, 90]) await sweepAt(T0 + h * H);
  ok('a corrupt project.json: nothing is stamped or deleted after four passes over 90 hours', (await count('knowledge_docs', `id = '${cdoc.id}'`)) === 1 && (await stamp(cdoc.id)) === null);
  await run(() => recordFs.rm(projectFile, { force: true }));
  await sweepAt(T0 + 100 * H);
  ok('NEGATIVE CONTROL: the same project with its record really gone is stamped', (await stamp(cdoc.id)) !== null);

  // (f) the migration
  const mig = (await b.pool.query('SELECT version FROM schema_migrations WHERE version >= 40 ORDER BY version')).rows.map((r) => r.version);
  ok('0042 applied, after 0041', mig.includes(41) && mig.includes(42) && mig.indexOf(41) < mig.indexOf(42), JSON.stringify(mig));
}).catch((err) => { console.error(err); process.exitCode = 1; }).finally(finish);
