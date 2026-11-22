// Sections 0, 2–5 and 7 of the folder safety net (docs/team-folders/00-design.md), over the real RPC route as the
// note's people, in a scratch Postgres (./folderHarness), then 9–10 (./folderNetSends) in the same world.
// scripts/test-folderSafetyNet.ts runs them after section 1; not a test file itself (no `test-` prefix).
//
// 0. INERT: with no folder besides Everyone, every steady reply (the same on two runs) is identical with the
//    folder checks on and off (src/server/authz/folderGate's seam), for every person; and projects:overview over 51
//    projects costs at most one statement more than no folder code, ⌘K none (./folderNetCost; NEGATIVE CONTROLS: per
//    project; folders resolved without asking first); and a dashboard's figure calls read nothing of reach (E5), E2's
//    one tree read per call at most.
// 2. THE SWEEP: every read contract with one payload each (naming HR's ids where it takes one), as opsViewer,
//    opsLead, opsEditorView, finViewer and ed: no reply carries an HR canary — but those in LATER, each a later
//    PR's, and each must still leak (so the list only shrinks). D8: no reply to Ops's Can-view callers carries
//    Ops's draft. NEGATIVE CONTROLS: padmin's replies carry the canaries; with the checks off, opsViewer's do;
//    opsLead (Can edit on Ops) reads Ops's draft.
// 3. BY ID: every ITEM channel on HR's ids answers opsViewer exactly what it answers for unknown ids; folder:of
//    says `closed` for HR's and nothing for unknown or open ones. NEGATIVE CONTROL: padmin gets the items.
// 4. FIGURES: every FIGURE channel on HR's dataset refuses `closed` (or answers as for an unknown id) for
//    opsViewer, and answers on Ops's twin; a chart on Orders labelled from HR's dimension refuses even when the
//    answer is cached. NEGATIVE CONTROLS: padmin is answered; with the doors' check of what a question reads off,
//    opsViewer is served the cached answer, HR's labels and all. Then reach (E5, ./folderNetReach): a dataset read
//    by a dashboard the caller opens answers its figures and nothing else, the publish refusal, the refresh push.
// 5. THE NET: getDataset and residentSource on HR in opsViewer's request refuse FolderError; SQL, a Prepare
//    union and a join preview over HR, as opsLead, carry no HR row. NEGATIVE CONTROL: padmin reads them.
// 7. SECURITY WALKS: figureDatasets is the same for opsViewer as for padmin, and so are hiddenAnywhere and
//    policyClosed; every wholeProject() call site is on WHOLE_PROJECT. NEGATIVE CONTROL: without wholeProject
//    the walk differs.
//
// The sweep covers E3's readers too (comments, mentions, stories, scorecards, scenarios, reports, Trash, versions,
// topics, Recent, Home, the switcher), on HR's planted records — and since E4 ⌘K and the Assistant's history, whose
// conversations held while HR was open (section 0) name its items. Section 6 (E4, ./folderNetIndexes): the indexes per
// person, by words and meaning, against their references, on Finance's canaries. Section 8 (writes) is E6's
// (./folderNetWrites), 11 E7's (./folderNetMoves).

import { randomUUID } from 'crypto';
import { ok } from './selfcheck';
import { READS } from './folderReaders';
import * as H from './folderHarness';
import { sendSections } from './folderNetSends';
import { reachSection } from './folderNetReach';
import * as cost from './folderNetCost';
import { indexSections } from './folderNetIndexes';
import { writeSections } from './folderNetWrites';
import { moveSection } from './folderNetMoves';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const api: typeof import('../src/api/index') = require('../src/api/index');
const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
const folders: typeof import('../src/server/authz/folders') = require('../src/server/authz/folders');
const { mentionsSettled }: typeof import('../src/server/mentions/notify') = require('../src/server/mentions/notify');
type Contract = import('../src/api/contract').Contract;
type Person = H.Person;

/** Replies a later PR makes hold: until then they may carry HR's names. Edit only to remove a line. Empty since E4. */
const LATER: Readonly<Record<string, string>> = {};
/** ITEM channels a later PR makes answer as for an unknown id. Edit only to remove a line. */
const LATER_BY_ID: Readonly<Record<string, string>> = {};
/** Read contracts no payload of ids satisfies, and no hand payload asks: org lists and the caller's own state. */
const UNSWEPT = new Set(['projects:list', 'projects:roles', 'onboarding:status', 'jobs:list', 'jobs:clear',
  'prefs:get', 'numbers:follow', 'tokens:list', 'connectors:catalog', 'connectors:logos', 'key:status', 'captureDataset:status', 'formula:functions', 'branding:logo',
  'calendar:today', 'themes:list', 'ai:status', 'channel:list', 'rebuild:read', 'embed:status', 'mentions:seen', 'mentions:prefs',
  'mentions:setPrefs', 'slack:myLink', 'slack:unlink']); // slack:*: the caller's own Slack link (no project, no id). setPrefs: the caller's own email switches (#525 made its input a union the sampler does not reach)
/** Every wholeProject() call site (D14): a security walk, a uniqueness check, or upkeep that is never a reply. */
const WHOLE_PROJECT: Readonly<Record<string, number>> = {
  'src/analysis/alertStore.ts': 1, // syncWatchRules: every watched dataset, or another folder's rules read as gone
  'src/analysis/publishedReads.ts': 2, // what a published copy reads (reach, D9); a reached metric's datasets
  'src/analysis/termNames.ts': 2, // a term's or metric's name is unique in the project
  'src/app/trash.ts': 1, // a restored verified question's words are unique in the project
  'src/data/datasetDependents.ts': 1, // the push refresh of every query over a changed dataset
  'src/data/rowAccess.ts': 2, // hiddenAnywhere; the project's rules, remembered across callers
  'src/engine/live/semantic/mirrors.ts': 2, // a mirror's name is unique in the project
  'src/ipc/folders.ts': 1, // folder:of: whether the item is there, and nothing else
  'src/ipc/metricSave.ts': 1, // a metric's name is unique in the project
  'src/ipc/metrics.ts': 1, // metric:ensureDefaults proposes only when the project (not the caller) has no metric
  'src/ipc/verified.ts': 1, // a verified question's words are unique in the project
  'src/server/authz/folderGate.ts': 1, // what a question reads (the doors)
  'src/server/autopilot/read.ts': 1, // Autopilot's scan: a chart in a folder the admin cannot open still counts as used (else it would be called unused and moved)
  'src/server/proposals/proposals.ts': 1, // approval: another name an editor's edit adds is unique in the project, as a metric's name is (no reply carries it)
  'src/server/subscriptions/figureDatasets.ts': 2, // figureDatasets, datasetsOfRoot
};
const SPARED: Person[] = ['opsViewer', 'opsLead', 'opsEditorView', 'finViewer', 'ed'];
/** Channels whose padmin reply must carry a canary: the walk can see what it guards. */
const CORE = ['an Ops visual labelled from HR', 'dataset:list', 'dataset:columns', 'analysis:gallery', 'analysis:open', 'visual:list', 'visual:get', 'metric:list', 'metric:get', 'term:list', 'term:get', 'verified:list', 'alerts:list', 'grid page', 'answer card', 'format:colors:get', 'catalog:list', 'catalog:get', 'catalog:columns', 'catalog:getTable', 'catalog:tags',
  // E3: what follows them — comments and mentions, stories, scorecards, scenarios, reports, Trash, versions, topics, Home and Recent.
  'comment:list', 'mentions:list', 'story:list', 'story:get', 'scorecard:list', 'scenario:list', 'reports:list', 'reports:get', 'trash:list', 'a visual version', 'a report version', 'topic with HR members', 'recent:list', 'home:overview'];

const HAND = (P: string, it: H.Items, labelled: string, more: Pick<H.World, 'topic' | 'versions'>): Array<[string, string, unknown]> => {
  const enc = { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] };
  return [
    ['chart batch', 'visual:dataBatch', { projectId: P, items: [{ datasetId: it.ds, encoding: enc }] }],
    ['dashboard tiles', 'analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: it.ds, encoding: enc }, { kind: 'metric', datasetId: it.ds, column: 'salary', aggregation: 'sum' }] }],
    ['KPI', 'dashboard:metric', { projectId: P, datasetId: it.ds, column: 'salary', aggregation: 'sum' }],
    ['metric preview', 'metric:preview', { projectId: P, datasetId: it.ds, definition: { column: 'salary', aggregation: 'sum' } }],
    ['metric values', 'metric:values', { projectId: P, ids: [it.metric] }],
    ['rows behind a mark', 'visual:rows', { projectId: P, datasetId: it.ds, encoding: enc, mark: { category: 'd1' } }],
    ['grid page', 'dataset:page', { projectId: P, datasetId: it.ds, offset: 0, limit: 200 }],
    ['filter values', 'dataset:distinct', { projectId: P, datasetId: it.ds, column: 'person' }],
    ['column panel', 'dataset:profile', { projectId: P, datasetId: it.ds, column: 'person' }],
    ['answer card', 'answer:card', { projectId: P, spec: { datasetId: it.ds, category: 'person', measures: [{ column: 'salary', aggregation: 'sum' }], filters: [] } }],
    ['gallery thumbnail', 'visual:thumbs', { projectId: P, ids: [it.visual] }],
    ['story figures', 'story:figures', { projectId: P, blocks: [{ id: 'b1', kind: 'visual', visualId: it.visual }] }],
    ['open its copy', 'analysis:open', { projectId: P, id: it.board, published: true }],
    ['statistics', 'stats:run', { projectId: P, spec: { kind: 'distribution', datasetId: it.ds, columns: ['salary'] } }],
    ['correlation', 'stats:pair', { projectId: P, datasetId: it.ds, x: 'salary', y: 'salary' }],
    ['segments: fit', 'segments:fit', { projectId: P, datasetId: it.ds, features: ['salary'] }],
    ['segments: RFM', 'segments:rfm', { projectId: P, datasetId: it.ds, spec: { id: 'person', date: 'day', amount: 'salary' } }],
    ['snapshot diff', 'snapshots:diff', { projectId: P, datasetId: it.ds, stamp: '2024-01-01T00-00-00-000Z' }],
    ['an Ops visual labelled from HR', 'visual:get', { projectId: P, id: labelled }],
    ['topic with HR members', 'topic:get', { projectId: P, id: more.topic }],
    ['visual history', 'versions:list', { projectId: P, type: 'visual', id: it.visual }],
    ['a visual version', 'versions:get', { projectId: P, type: 'visual', id: it.visual, key: more.versions.visual }],
    ['a report version', 'versions:get', { projectId: P, type: 'report', id: it.report, key: more.versions.report }],
    ['recent:list', 'recent:list', { limit: 50 }],
    ['mentions:list', 'mentions:list', undefined],
    ['projects:overview', 'projects:overview', undefined],
    ['starred:get', 'starred:get', undefined],
    ['subscription preview', 'subscription:preview', { projectId: P, draft: { name: 'Weekly', analysisId: it.board, content: { mode: 'all', cardIds: [] }, schedule: { kind: 'weekly', weekday: 1, hour: 9, minute: 0 }, timezone: 'UTC', channelIds: [], message: { title: '', note: '', includeLink: true }, conditions: { skipUnchanged: false, onlyWhenRefreshed: false } } }],
  ];
};

/** One call per label: the generic sweep (each read contract's schema, filled with `it`'s ids), then the hand payloads. */
function calls(P: string, it: H.Items, labelled: string, more: Pick<H.World, 'topic' | 'versions'>): { list: Array<[string, string, unknown]>; unswept: string[] } {
  const hand = HAND(P, it, labelled, more);
  const list: Array<[string, string, unknown]> = [];
  const unswept: string[] = [];
  for (const [ch, c] of Object.entries(api.contracts as unknown as Record<string, Contract>)) {
    if (c.access !== 'read') continue;
    const p = H.payloadFor(c as never, H.valuesFor(P, it, ch));
    if (p) list.push([ch, ch, p]);
    else if (!hand.some(([, x]) => x === ch)) unswept.push(ch);
  }
  return { list: [...list, ...hand], unswept };
}

const classOf = (ch: string): string => READS[ch] ?? '';
/** Where two texts first differ, with a little on each side. */
const around = (a: string, b: string): string => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `…${a.slice(Math.max(0, i - 60), i + 60)} | …${b.slice(Math.max(0, i - 60), i + 60)}`;
};
const short = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 160)}`;

export async function databaseSections(): Promise<void> {
  const W = await H.world('folder safety net, sections 2–5 and 7');
  if (!W) return;
  const { P, hr, ops } = W;
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  try {
    await mentionsSettled(); // the HR comment's mention row, written as the world was made
    const { list, unswept } = calls(P, hr, W.labelled, W);
    const newUnswept = unswept.filter((ch) => !UNSWEPT.has(ch));
    ok(`the sweep: ${list.length} calls; every read contract is asked but the ${UNSWEPT.size} UNSWEPT ones (org lists, the caller's own state)`, newUnswept.length === 0, newUnswept.join(' '));
    const sweep = async (who: Person, l = list): Promise<Map<string, H.Reply>> => {
      const out = new Map<string, H.Reply>();
      for (const [label, ch, payload] of l) out.set(label, await W.call(who, ch, payload));
      return out;
    };

    // ── 0. Inert: no folder → the same replies, checks on or off ────────
    const everyone: Person[] = ['opsViewer', 'opsLead', 'ed', 'padmin'];
    const runAll = async (): Promise<Map<string, string>> => {
      const m = new Map<string, string>();
      for (const who of everyone) for (const [label, r] of await sweep(who)) m.set(`${who} ${label}`, H.stable(r));
      return m;
    };
    const on1 = await runAll();
    const on2 = await runAll();
    gate.setFolderChecksForTest(false);
    const off = await runAll().finally(() => gate.setFolderChecksForTest(true));
    const steady = [...on1.keys()].filter((k) => on1.get(k) === on2.get(k));
    const moved = steady.filter((k) => off.get(k) !== on1.get(k));
    ok(`inert: with no folder, ${steady.length} of ${on1.size} replies are steady, and each is the same with the folder checks off`, steady.length > on1.size * 0.8 && moved.length === 0,
      moved.slice(0, 3).map((k) => `${k}: ${around(on1.get(k) ?? '', off.get(k) ?? '')}`).join('\n'));

    // …and in cost: the switcher over 51 projects asks which have a folder once, and reads no tree (./folderNetCost).
    const spare = await cost.moreProjects(W, 50);
    await cost.bare(W, spare.length + 1);
    await cost.bareSearch(W);
    const enc = { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] };
    await cost.figuresBare(W, [['analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: ops.ds, encoding: enc, chartType: 'bar' }, { kind: 'metric', metricId: ops.metric, datasetId: ops.ds, column: 'salary', aggregation: 'sum' }] }],
      ['visual:rows', { projectId: P, datasetId: ops.ds, encoding: enc, mark: { category: 'd1' } }], ['dataset:distinct', { projectId: P, datasetId: ops.ds, column: 'dept' }]]);

    await W.plantFolders();

    // ── 2. The sweep ─────────────────────────────────────────────────────
    const seen = new Map<Person, Map<string, H.Reply>>();
    for (const who of [...SPARED, 'padmin'] as Person[]) seen.set(who, await sweep(who));
    const leaksOf = (who: Person, re = H.CANARY): string[] => [...(seen.get(who) ?? [])].filter(([, r]) => re.test(r.text)).map(([label]) => label);
    for (const who of SPARED) {
      const leaks = leaksOf(who).filter((l) => !(l in LATER));
      ok(`sweep: no reply of ${list.length} to ${who} carries an HR canary (LATER aside)`, leaks.length === 0, leaks.map((l) => `${l}: ${short(seen.get(who)!.get(l)!)}`).join('\n'));
    }
    const stillLeak = Object.keys(LATER).filter((l) => SPARED.some((who) => leaksOf(who).includes(l)));
    ok(`sweep: every LATER channel still carries one (fixed? remove it from LATER) — ${Object.keys(LATER).length} left`, stillLeak.length === Object.keys(LATER).length, Object.keys(LATER).filter((l) => !stillLeak.includes(l)).join(', '));
    const padminHistory = ['search:query', 'copilot:history', 'copilot:threads'].filter((l) => leaksOf('padmin').includes(l));
    ok('NEGATIVE CONTROL: padmin\'s ⌘K, history and conversation list carry HR\'s canaries (what E4 holds)', padminHistory.length === 3, padminHistory.join(', '));
    const padminSees = leaksOf('padmin');
    ok(`NEGATIVE CONTROL: padmin's replies carry HR's canaries (${padminSees.length} channels, every core one)`, CORE.every((c) => padminSees.includes(c)), CORE.filter((c) => !padminSees.includes(c)).join(', '));
    gate.setFolderChecksForTest(false);
    const unguarded = await sweep('opsViewer', list.filter(([label]) => CORE.includes(label))).finally(() => gate.setFolderChecksForTest(true));
    const blind = CORE.filter((c) => !H.CANARY.test(unguarded.get(c)?.text ?? ''));
    ok('NEGATIVE CONTROL: with the folder checks off, opsViewer\'s core replies carry HR\'s canaries', blind.length === 0, blind.join(', '));
    for (const who of ['opsViewer', 'opsEditorView'] as Person[]) {
      const drafts = leaksOf(who, H.OPS_DRAFT).filter((l) => !(l in LATER));
      ok(`D8: no reply to ${who} (Can view on Ops) carries Ops's draft — only its published copy`, drafts.length === 0, drafts.join(', '));
    }
    const leadDrafts = leaksOf('opsLead', H.OPS_DRAFT);
    ok('NEGATIVE CONTROL: opsLead (Can edit on Ops) reads Ops\'s draft in the gallery', leadDrafts.includes('analysis:gallery'), leadDrafts.join(', '));
    const tagOf = async (who: Person) => (await W.call(who, 'visual:get', { projectId: P, id: W.labelled })).body?.tag;
    ok('an Ops visual labelled from HR: opsLead (an editor) is sent it without HR\'s labels and with the tag of what was sent, so a save from it refuses', (await tagOf('opsLead')) !== (await tagOf('padmin')) && typeof (await tagOf('opsLead')) === 'string');
    const opsOpen = (await W.call('opsEditorView', 'analysis:open', { projectId: P, id: ops.board })).body;
    ok('D8: opsEditorView opens Ops board as its published copy, by its published name', opsOpen?.ok === true && opsOpen.showing === 'published' && opsOpen.analysis?.name === 'Ops board', JSON.stringify(opsOpen).slice(0, 200));

    // ── 3. By id ─────────────────────────────────────────────────────────
    const unknown = Object.fromEntries([...Object.values(hr), W.hrDim].map((id) => [id, randomUUID()]));
    const back = Object.fromEntries(Object.entries(unknown).map(([a, b]) => [b, a]));
    const items = list.filter(([, ch]) => classOf(ch) === 'ITEM');
    const differ: string[] = [];
    for (const [label, ch, payload] of items) {
      const mine = seen.get('opsViewer')!.get(label)!;
      const missing = await W.call('opsViewer', ch, H.swapped(payload, unknown));
      if (!(label in LATER_BY_ID) && H.stable(mine) !== H.stable({ ...missing, body: H.swapped(missing.body, back) })) differ.push(`${label}: ${short(mine)} | ${short(missing)}`);
    }
    ok(`by id: each of ${items.length} ITEM channels answers opsViewer on HR's ids exactly as on unknown ids (LATER_BY_ID aside)`, items.length > 10 && differ.length === 0, differ.join('\n'));
    const itemSeen = ['analysis:open', 'visual:get', 'metric:get', 'term:get'].filter((l) => H.CANARY.test(seen.get('padmin')!.get(l)?.text ?? ''));
    ok('NEGATIVE CONTROL: padmin gets HR\'s dashboard, visual, metric and term by id', itemSeen.length === 4, itemSeen.join(', '));
    const of = (who: Person, kind: string, id: string) => W.call(who, 'folder:of', { projectId: P, kind, id });
    const ofHr = [await of('opsViewer', 'dataset', hr.ds), await of('opsViewer', 'dashboard', hr.board)];
    ok('folder:of: HR\'s dataset and dashboard are `closed` to opsViewer, with the catalog\'s sentence and nothing else', ofHr.every((r) => H.refused(r) && !H.CANARY.test(r.text) && r.body?.error === folders.folderRefusal('closed').error), ofHr.map(short).join(' | '));
    const ofNone = [await of('opsViewer', 'dataset', randomUUID()), await of('opsViewer', 'dataset', ops.ds), await of('opsViewer', 'dashboard', ops.board), await of('padmin', 'dataset', hr.ds)];
    ok('folder:of: an unknown id, an open item and padmin on HR\'s answer {ok:true}', ofNone.every((r) => r.status === 200 && r.body?.ok === true), ofNone.map(short).join(' | '));

    // ── 4. Figures ───────────────────────────────────────────────────────
    const toOps = Object.fromEntries(Object.keys(hr).map((k) => [hr[k as keyof H.Items], ops[k as keyof H.Items]]));
    const figures = list.filter(([, ch]) => classOf(ch) === 'FIGURE');
    const open: string[] = [];
    const shut: string[] = [];
    const answered: string[] = [];
    let closed = 0;
    for (const [label, ch, payload] of figures) {
      const mine = seen.get('opsViewer')!.get(label)!;
      const missing = await W.call('opsViewer', ch, H.swapped(payload, unknown));
      if (H.refused(mine)) closed++;
      else if (H.stable(mine) !== H.stable({ ...missing, body: H.swapped(missing.body, back) })) open.push(`${label}: ${short(mine)}`);
      if (H.refused(await W.call('opsViewer', ch, H.swapped(payload, toOps)))) shut.push(label);
      if (!H.refused(seen.get('padmin')!.get(label)!)) answered.push(label);
    }
    ok(`figures: each of ${figures.length} FIGURE channels on HR refuses opsViewer \`closed\` (${closed}) or answers as for an unknown id (the rest)`, figures.length > 10 && closed > 0 && open.length === 0, open.join('\n'));
    ok('figures: on Ops\'s twin nothing refuses opsViewer `closed`', shut.length === 0, shut.join(', '));
    ok('NEGATIVE CONTROL: padmin\'s figure calls on HR are not refused', answered.length === figures.length, figures.map(([l]) => l).filter((l) => !answered.includes(l)).join(', '));
    const labelled = { projectId: P, datasetId: ops.ds, encoding: { category: 'label', categoryDatasetId: W.hrDim, values: [{ column: 'salary', aggregation: 'sum' }] } };
    const cached = await W.call('padmin', 'visual:data', labelled);
    ok('setup: padmin\'s chart on Orders labelled from HR\'s dimension reads HR\'s labels (and is cached)', /HRCANARY_label/.test(cached.text), short(cached));
    const joined = await W.call('opsViewer', 'visual:data', labelled);
    ok('figures: the same chart refuses opsViewer `closed` — it reads HR, however it is cached', H.refused(joined) && !H.CANARY.test(joined.text), short(joined));
    gate.setDoorReadsForTest(false);
    const leaked = await W.call('opsViewer', 'visual:data', labelled).finally(() => gate.setDoorReadsForTest(true));
    ok('NEGATIVE CONTROL: with the doors\' check of what a question reads off, opsViewer is served the cached answer, HR\'s labels and all', /HRCANARY_label/.test(leaked.text), short(leaked));
    await reachSection(W, list.filter(([, ch]) => classOf(ch) === 'OPEN'), toOps, unknown); // E5: reach (./folderNetReach)

    // ── 5. The net ───────────────────────────────────────────────────────
    const net = (who: Person, fn: () => Promise<unknown>): Promise<string> => W.as(who, fn).then((v) => (v ? 'read' : 'null'), (e: unknown) => (folders.isFolderError(e) ? 'refused' : `threw ${(e as Error).message}`));
    ok('net: getDataset(HR) in opsViewer\'s request refuses FolderError', (await net('opsViewer', () => datasets.getDataset(P, hr.ds))) === 'refused');
    ok('net: residentSource(HR) in opsViewer\'s request refuses FolderError', (await net('opsViewer', () => datasets.residentSource(P, hr.ds))) === 'refused');
    ok('net: getDatasetMeta(HR) is null for opsViewer, as a missing id', (await net('opsViewer', () => datasets.getDatasetMeta(P, hr.ds))) === 'null');
    ok('NEGATIVE CONTROL: padmin reads all three', (await net('padmin', () => datasets.getDataset(P, hr.ds))) === 'read' && (await net('padmin', () => datasets.residentSource(P, hr.ds))) === 'read' && (await net('padmin', () => datasets.getDatasetMeta(P, hr.ds))) === 'read');
    // The SQL names HR's table, so its reply is searched for HR's rows (HRCANARY_0…), never for the name asked.
    const sideways: Array<[string, string, unknown, RegExp]> = [
      ['SQL over HR', 'sql:run', { projectId: P, sql: 'SELECT person FROM "HRCANARY Salaries"' }, /HRCANARY_\d/],
      ['a Prepare union of HR into Orders', 'prepare:stepPreview', { projectId: P, datasetId: ops.ds, index: -1, step: { type: 'union', datasetId: hr.ds } }, H.CANARY],
      ['a join preview of Orders with HR', 'dataset:composePreview', { projectId: P, base: { datasetId: ops.ds }, joins: [{ datasetId: hr.ds, mode: 'left', on: { left: 'dept', right: 'dept' } }], offset: 0, limit: 50 }, H.CANARY],
    ];
    for (const [label, ch, payload, canary] of sideways) {
      const mine = await W.call('opsLead', ch, payload);
      const theirs = await W.call('padmin', ch, payload);
      ok(`net: ${label} (${ch}) reads nothing of HR for opsLead, an editor`, !canary.test(mine.text) && mine.body?.ok !== true, short(mine));
      ok(`NEGATIVE CONTROL: ${label} — padmin reads HR`, canary.test(theirs.text), short(theirs));
    }

    // ── 7. Security walks ────────────────────────────────────────────────
    const figureDatasets: typeof import('../src/server/subscriptions/figureDatasets') = require('../src/server/subscriptions/figureDatasets');
    const rowAccess: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
    const walk = (who: Person, id: string): Promise<string> => W.as(who, async () => JSON.stringify(await figureDatasets.figureDatasets({ kind: 'dashboard', projectId: P, analysisId: id }))).catch((e: Error) => `threw ${e.message}`);
    const walked: string[] = [];
    for (const [id, reads] of [[hr.board, hr.ds], [ops.board, W.hrDim]]) {
      const [mine, theirs] = [await walk('opsViewer', id), await walk('padmin', id)];
      if (mine !== theirs || !theirs.includes(reads)) walked.push(`${mine} | ${theirs}`);
    }
    ok('walks: figureDatasets of HR\'s and Ops\'s dashboards is the same for opsViewer as for padmin, HR\'s datasets included', walked.length === 0, walked.join('\n'));
    const facts = async (who: Person) => W.as(who, async () => JSON.stringify([[...(await rowAccess.hiddenAnywhere(P))].sort(), await rowAccess.policyClosed(P, hr.ds), await rowAccess.policyClosed(P, ops.ds)]));
    ok('walks: hiddenAnywhere and policyClosed are the same for opsViewer as for padmin', (await facts('opsViewer')) === (await facts('padmin')));
    const real = folders.wholeProject;
    (folders as { wholeProject: typeof real }).wholeProject = (fn) => fn();
    const narrowed = await walk('opsViewer', hr.board).finally(() => { (folders as { wholeProject: typeof real }).wholeProject = real; });
    ok('NEGATIVE CONTROL: without wholeProject, opsViewer\'s walk of HR\'s dashboard differs (it reads as gone)', narrowed !== (await walk('padmin', hr.board)), narrowed.slice(0, 120));
    const sites = wholeProjectSites();
    ok('walks: every wholeProject() call site is on WHOLE_PROJECT, as many times as listed', JSON.stringify(sites) === JSON.stringify(WHOLE_PROJECT), JSON.stringify(sites));

    await sendSections(W); // 9–10 (E3): pushes, sends, mentions, counts; MCP and the model's prompts
    await cost.foldered(W, spare); // 9: with folders on P and one more, the switcher reads those two trees only
    await indexSections(W); // 6 (E4): ⌘K, words, meaning, counts, verified, history — after the sends: it makes items of its own
    await cost.folderedSearch(W);
    await writeSections(W); // 8 (E6): writes — its controls change and delete things
    await moveSection(W); // 11 (E7): the folder channels, and a move's reach change is what its warning said
  } finally {
    await W.close();
  }
}

/** `wholeProject(` per source file under src/, the definition aside. */
function wholeProjectSites(): Record<string, number> {
  const root = path.join(__dirname, '..');
  const out: Record<string, number> = {};
  const visit = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) visit(rel);
      else if (rel.endsWith('.ts')) {
        const n = (fs.readFileSync(path.join(root, rel), 'utf8').match(/wholeProject\(/g) ?? []).length - (rel === 'src/server/authz/folders.ts' ? 1 : 0);
        if (n > 0) out[rel] = n;
      }
    }
  };
  visit('src');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
