// Who may do what with a knowledge document (docs/knowledge-docs/00-design.md rules 2, 3 and the upload), on the real app
// over a scratch database (scripts/notifyHarness.ts: header sign-in, RPC over HTTP). Without DATABASE_URL: one skip line.
//
//   (a) a project's documents: a viewer lists and reads them but cannot save, upload or delete (403); an editor can —
//       NEGATIVE CONTROL: the same calls as the editor succeed
//   (b) an agent's documents: those who may USE the agent list and read them; a viewer outside its teams gets "gone" for the
//       list and for the id (never the text); an editor (who may try any agent) manages them; a trashed agent's are neither
//       listed nor read, and come back with a restore
//   (c) an id from another project is gone even for a caller who reads both; a document of another org is invisible; a project
//       the caller cannot read is 403
//   (d) a stale `base` is 409 record_changed, with the current tag — NEGATIVE CONTROL: the current one saves
//   (e) upload (the staged file, single use): Markdown, Word and PDF are read and stored with the text shown back and the
//       staged file spent; a file that cannot be read is refused with its own sentence and stores nothing; an upload to an
//       agent the caller may not use is refused before the token is spent
//   (f) no database: the channels say so, and nothing throws
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-knowledgeAccess.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { BOSS, ORG, show, withServer } from './notifyHarness';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const JSZip: typeof import('jszip') = require('jszip');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const inOrgMod: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const msg: typeof import('../src/knowledge/knowledgeMessages') = require('../src/knowledge/knowledgeMessages');

withServer('knowledge-access', {}, async (b) => {
  const call = async (as: string, channel: string, payload: unknown): Promise<{ status: number; body: any }> => { // any: each channel's own reply
    const r = await b.as(as).call(channel, payload);
    return { status: r.status, body: r.body };
  };
  const must = async (as: string, channel: string, payload: unknown): Promise<any> => { // any: each channel's own reply
    const r = await call(as, channel, payload);
    if (r.status !== 200) throw new Error(`${channel} as ${as}: ${r.status} ${show(r.body)}`);
    return r.body;
  };
  const P: string = await b.run(BOSS, async () => (await projects.createProject('Docs access')).id);
  const P2: string = await b.run(BOSS, async () => (await projects.createProject('Docs elsewhere')).id);
  await b.provision('fay', 'vic', 'ed', 'out');
  await must('boss', 'admin:setRole', { userId: await b.uid('ed'), role: 'editor' }); // uploads (POST /api/files) need an org editor
  const team: string = (await must('boss', 'admin:createTeam', { name: 'Finance' })).id;
  await must('boss', 'admin:teamMember', { teamId: team, userId: await b.uid('fay'), member: true });
  for (const p of [P, P2]) { await b.share(p, 'fay', 'viewer'); await b.share(p, 'vic', 'viewer'); await b.share(p, 'ed', 'editor'); }
  const IN = { name: 'Finance assistant', topicId: null, model: null, build: false, teamIds: [team] };
  const A: string = (await must('boss', 'agent:save', { projectId: P, agent: IN })).agent.id;

  // (a) the project's documents
  const made = await must('ed', 'knowledge:save', { projectId: P, title: 'Revenue policy', text: '# Revenue\n\nNet of refunds.' });
  const D: string = made.doc?.id ?? '';
  ok('an editor saves a project document', made.ok === true && made.doc.agentId === null && made.doc.source === 'typed' && made.doc.tag, show(made));
  for (const v of ['fay', 'vic']) {
    const list = await must(v, 'knowledge:list', { projectId: P });
    const get = await must(v, 'knowledge:get', { projectId: P, id: D });
    ok(`a viewer (${v}) lists and reads it, the list holds no text`, list.ok && list.docs.length === 1 && list.docs[0].id === D && !('text' in list.docs[0]) && list.canEdit === false && list.max === 100 && get.ok && get.doc.text.includes('Net of refunds'), show(list));
    const writes = await Promise.all([
      call(v, 'knowledge:save', { projectId: P, title: 'x', text: 'y' }),
      call(v, 'knowledge:save', { projectId: P, id: D, title: 'x', text: 'y' }),
      call(v, 'knowledge:delete', { projectId: P, id: D }),
      call(v, 'knowledge:upload', { projectId: P, fileToken: 'A'.repeat(43) }),
    ]);
    ok(`…but cannot save, edit, delete or upload (403)`, writes.every((r) => r.status === 403), writes.map((r) => r.status).join());
  }
  const edList = await must('ed', 'knowledge:list', { projectId: P });
  ok('NEGATIVE CONTROL: the editor lists with canEdit', edList.ok && edList.canEdit === true && edList.total === 1);

  // (b) an agent's documents
  const own = await must('ed', 'knowledge:save', { projectId: P, agentId: A, title: 'Finance glossary', text: 'Fiscal quarter means three months.' });
  ok('an editor saves an agent\'s document (an editor may try any agent)', own.ok === true && own.doc.agentId === A, show(own));
  const fayAgent = await must('fay', 'knowledge:list', { projectId: P, agentId: A });
  ok('Fay, who may use the agent, lists its documents and reads one, and sees the project\'s count', fayAgent.ok && fayAgent.docs.length === 1 && fayAgent.docs[0].title === 'Finance glossary' && fayAgent.projectDocs === 1 && (await must('fay', 'knowledge:get', { projectId: P, id: own.doc.id })).ok, show(fayAgent));
  ok('the project list never holds the agent\'s documents', (await must('fay', 'knowledge:list', { projectId: P })).docs.every((d: { agentId: string | null }) => d.agentId === null));
  const vicAgent = await must('vic', 'knowledge:list', { projectId: P, agentId: A });
  const vicGet = await must('vic', 'knowledge:get', { projectId: P, id: own.doc.id });
  ok('Vic, outside its teams: the list is "gone" and the document is gone, with no text in the reply', vicAgent.ok === false && vicGet.ok === false && vicGet.error === msg.docGone() && !JSON.stringify([vicAgent, vicGet]).includes('three months'), show([vicAgent, vicGet]));
  const vicWrite = await Promise.all([call('vic', 'knowledge:save', { projectId: P, agentId: A, title: 'x', text: 'y' }), call('vic', 'knowledge:delete', { projectId: P, id: own.doc.id })]);
  ok('…and cannot write to it (403)', vicWrite.every((r) => r.status === 403));
  ok('NEGATIVE CONTROL: Fay reads it — the agent, not the project role, decides', (await must('fay', 'knowledge:get', { projectId: P, id: own.doc.id })).doc.text.includes('three months'));
  await must('boss', 'agent:delete', { projectId: P, id: A });
  const trashedList = await must('fay', 'knowledge:list', { projectId: P, agentId: A });
  const trashedGet = await must('ed', 'knowledge:get', { projectId: P, id: own.doc.id });
  ok('a trashed agent\'s documents are neither listed nor read (even by an editor)…', trashedList.ok === false && trashedGet.ok === false);
  ok('…and still count toward the 100', (await must('ed', 'knowledge:list', { projectId: P })).total === 2);
  await must('boss', 'trash:restore', { projectId: P, type: 'agent', id: A });
  ok('NEGATIVE CONTROL: a restore brings them back', (await must('fay', 'knowledge:list', { projectId: P, agentId: A })).docs.length === 1);

  // (c) other projects and orgs
  const other = await must('ed', 'knowledge:get', { projectId: P2, id: D });
  ok('an id of another project is gone, even for a caller who reads both', other.ok === false && other.error === msg.docGone(), show(other));
  ok('…and cannot be edited or deleted through the other project', (await must('ed', 'knowledge:save', { projectId: P2, id: D, title: 'x', text: 'y' })).ok === false && (await must('ed', 'knowledge:delete', { projectId: P2, id: D })).ok === false);
  await b.pool.query(`INSERT INTO knowledge_docs (org_id, project_id, id, title, source, chars, text, text_hash, created_by, updated_by) VALUES ('other', $1, '99999999-9999-4999-8999-999999999999', 'Theirs', 'typed', 1, 'secret', 'h', 'u', 'u')`, [P]);
  const foreign = await must('boss', 'knowledge:get', { projectId: P, id: '99999999-9999-4999-8999-999999999999' });
  ok('another org\'s document, even at the same project id, is invisible (the org admin too)', foreign.ok === false && !(await must('boss', 'knowledge:list', { projectId: P })).docs.some((d: { title: string }) => d.title === 'Theirs'));
  const outsider = await call('out', 'knowledge:list', { projectId: P });
  ok('a member with no grant on the project: 403', outsider.status === 403, String(outsider.status));
  ok('NEGATIVE CONTROL: a malformed id is refused at the contract', (await call('ed', 'knowledge:get', { projectId: P, id: '../etc' })).status === 400 || (await call('ed', 'knowledge:get', { projectId: P, id: '../etc' })).status === 422);

  // (d) the edit tag
  const cur = (await must('ed', 'knowledge:get', { projectId: P, id: D })).doc;
  const stale = await call('ed', 'knowledge:save', { projectId: P, id: D, base: 'x'.repeat(43), title: 'Revenue policy', text: 'Changed.' });
  ok('a stale base is 409 record_changed with the current tag', stale.status === 409 && JSON.parse(stale.body).code === 'record_changed' && JSON.parse(stale.body).tag === cur.tag && (await must('ed', 'knowledge:get', { projectId: P, id: D })).doc.text.includes('Net of refunds'), show(stale));
  const edited = await must('ed', 'knowledge:save', { projectId: P, id: D, base: cur.tag, title: 'Revenue policy', text: 'Changed.' });
  ok('NEGATIVE CONTROL: the current base saves, and the tag moves', edited.ok && edited.doc.text === 'Changed.' && edited.doc.tag !== cur.tag, show(edited));
  const tooLong = await must('ed', 'knowledge:save', { projectId: P, title: 'Huge', text: 'a'.repeat(300_001) });
  ok('over 300,000 characters: refused with its sentence', tooLong.ok === false && /300,000/.test(tooLong.error), show(tooLong).slice(0, 200));

  // (e) upload
  const upload = async (as: string, name: string, bytes: Buffer): Promise<string> => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), name);
    const r = await fetch(`${b.base}/api/files`, { method: 'POST', body: form, headers: withCsrf({ 'x-forwarded-email': `${as}@acme.test` }) });
    const j = (await r.json()) as { fileToken: string };
    if (!j.fileToken) throw new Error(`upload ${name} as ${as}: ${r.status} ${JSON.stringify(j)}`);
    return j.fileToken;
  };
  const md = await must('ed', 'knowledge:upload', { projectId: P, fileToken: await upload('ed', 'Fiscal_calendar.md', Buffer.from('# Fiscal\n\nThe year starts in February.\n')) });
  ok('Markdown: read, titled from the file name, kind and file name kept', md.ok && md.doc.source === 'markdown' && md.doc.title === 'Fiscal calendar' && md.doc.fileName === 'Fiscal_calendar.md', show(md));
  const shown = await must('fay', 'knowledge:get', { projectId: P, id: md.doc.id });
  ok('the extracted text is shown back to a reader exactly', shown.doc.text === '# Fiscal\n\nThe year starts in February.\n');
  const z = new JSZip();
  z.file('word/document.xml', '<w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Churn</w:t></w:r></w:p><w:p><w:r><w:t>Customers lost.</w:t></w:r></w:p></w:body></w:document>');
  const docx = await must('ed', 'knowledge:upload', { projectId: P, title: 'Churn page', fileToken: await upload('ed', 'churn.docx', await z.generateAsync({ type: 'nodebuffer' })) });
  ok('Word: read, with the title the editor gave', docx.ok && docx.doc.source === 'docx' && docx.doc.title === 'Churn page' && (await must('ed', 'knowledge:get', { projectId: P, id: docx.doc.id })).doc.text === '# Churn\n\nCustomers lost.', show(docx));
  const pdf = await must('ed', 'knowledge:upload', { projectId: P, agentId: A, fileToken: await upload('ed', 'hello.pdf', fs.readFileSync(path.join(__dirname, 'fixtures', 'knowledge', 'hello.pdf'))) });
  ok('PDF: read, stored for the agent', pdf.ok && pdf.doc.source === 'pdf' && pdf.doc.agentId === A && (await must('ed', 'knowledge:get', { projectId: P, id: pdf.doc.id })).doc.text.includes('Refunds are deducted from net revenue.'), show(pdf));
  const before = (await must('ed', 'knowledge:list', { projectId: P })).total;
  const token = await upload('ed', 'locked.pdf', fs.readFileSync(path.join(__dirname, 'fixtures', 'knowledge', 'locked.pdf')));
  const locked = await must('ed', 'knowledge:upload', { projectId: P, fileToken: token });
  ok('an encrypted PDF is refused with its own sentence, storing nothing', locked.ok === false && locked.error === msg.encrypted() && (await must('ed', 'knowledge:list', { projectId: P })).total === before, show(locked));
  const reuse = await must('ed', 'knowledge:upload', { projectId: P, fileToken: token });
  ok('the staged file is spent: the same token again is expired (the original is not kept)', reuse.ok === false && reuse.error === msg.uploadExpired(), show(reuse));
  const scan = await must('ed', 'knowledge:upload', { projectId: P, fileToken: await upload('ed', 'scan.pdf', fs.readFileSync(path.join(__dirname, 'fixtures', 'knowledge', 'scan.pdf'))) });
  const dot = await must('ed', 'knowledge:upload', { projectId: P, fileToken: await upload('ed', 'old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0])) });
  ok('a scan and an old .doc each get their own refusal', scan.ok === false && scan.error === msg.noText() && dot.ok === false && dot.error === msg.typeNotAccepted(), show([scan, dot]));
  const vicTok = await upload('ed', 'viewer.md', Buffer.from('# x'));
  const vicUp = await call('vic', 'knowledge:upload', { projectId: P, fileToken: vicTok });
  ok('a viewer\'s knowledge:upload is refused (403) and the token is not spent', vicUp.status === 403 && (await must('ed', 'knowledge:upload', { projectId: P, fileToken: vicTok })).ok === true);
  const farTok = await upload('ed', 'x.md', Buffer.from('# x'));
  const farAgent = await must('ed', 'knowledge:upload', { projectId: P, agentId: '00000000-0000-4000-8000-000000000999', fileToken: farTok });
  ok('an upload for an agent that is not there is refused BEFORE the token is spent', farAgent.ok === false && (await must('ed', 'knowledge:upload', { projectId: P, fileToken: farTok })).ok === true);

  // (f) no database
  inOrgMod.useOrgDb(null);
  const none = await Promise.all([must('ed', 'knowledge:list', { projectId: P }), must('ed', 'knowledge:save', { projectId: P, title: 'x', text: 'y' }), must('ed', 'knowledge:get', { projectId: P, id: D })]);
  ok('without a database every channel says so', none.every((r) => r.ok === false && r.needsDatabase === true && r.error === msg.needsDatabase()), show(none));
  inOrgMod.useOrgDb(b.pool);
  ok('NEGATIVE CONTROL: with it back, they work', (await must('ed', 'knowledge:list', { projectId: P })).ok === true);
  void ORG;
}).catch((err) => { console.error(err); process.exitCode = 1; }).finally(finish);
