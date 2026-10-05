// Self-check for src/app/bundle.ts — the .ordinate project bundle.
//
// On the REAL sample (seeded through the first-launch path), extended with the
// two things a bundle most easily breaks: a dataset WITH A PIPELINE (the sample's
// Month field, whose source Parquet must travel too) and a dashboard WITH A
// FILTER BAR (a control card naming the dataset by id).
//
//   1. ROUND TRIP: export → import gives a new project whose records match the
//      source's, table rows included.
//   2. ID REMAP: importing on the same machine collides with every id; every
//      one is replaced, in file names and in bodies, and every reference
//      follows (a control card points at the NEW dataset).
//   3. WHITELIST: a bundle with any entry outside it is refused whole, and
//      leaves no project behind.
//   4. MANIFEST: counts that do not match the entries are refused.
//
//   npm run build:ts && node scripts/test-bundle.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bundle-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// ponytail: compiled siblings of the real modules.
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');

function allText(dir: string): string {
  let out = '';
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { out += p + '\n'; if (p.endsWith('.json')) out += fs.readFileSync(p, 'utf8') + '\n'; }
    }
  };
  walk(dir);
  return out;
}

async function main(): Promise<void> {
  const seeded = await sample.seedSampleProject();
  if (!seeded.projectId || !seeded.analysisId) throw new Error('sample not seeded');
  const pid = seeded.projectId;
  const ds = (await datasets.listDatasets(pid))[0];
  const meta0 = await datasets.getDatasetMeta(pid, ds.id);
  ok('the sample dataset carries a pipeline (the Month field)',
    !!meta0 && Array.isArray(meta0.steps) && meta0.steps.some((s: any) => s.name === 'Month'));

  // A filter bar: one control card on the sample dashboard.
  const a0 = await analysis.getAnalysis(pid, seeded.analysisId);
  const sheets = JSON.parse(JSON.stringify(a0!.sheets));
  sheets[0].cards.push({ type: 'control', layout: { x: 0, y: 0, w: 3, h: 1 },
    control: { kind: 'dropdown', label: 'Region', datasetId: ds.id, column: 'region' } });
  await analysis.updateAnalysis(pid, seeded.analysisId, { sheets });
  await versions.record(pid, 'dashboard', (await analysis.getAnalysis(pid, seeded.analysisId))!);
  await alertStore.saveRule(pid, { name: 'Revenue dips', datasetId: ds.id, compare: 'threshold',
    threshold: { op: '<', value: 1 }, metric: { column: 'revenue', aggregation: 'sum' } });
  // Things that must NOT travel.
  const srcDir = path.join(tmpUserData, 'projects', pid);
  fs.writeFileSync(path.join(srcDir, 'copilot.json'), '{"threads":[]}');
  fs.mkdirSync(path.join(srcDir, 'trash', 'visual'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'trash', 'visual', '11111111-1111-4111-8111-111111111111.json'), '{}');

  // ── 1. export ───────────────────────────────────────────────────────────────
  const out = await bundle.exportProject(pid);
  if (!out) throw new Error('export returned nothing');
  const names = bundle.readZip(out.bytes).map((e) => e.name);
  ok('the manifest is the first entry', names[0] === 'manifest.json');
  ok('…naming the format, the app version and the project',
    out.manifest.format === 'ordinate-project' && out.manifest.appVersion === require('../package.json').version && out.manifest.project.name === 'My project');
  ok('…and counting every record kind',
    out.manifest.counts.datasets === 1 && out.manifest.counts.parquet === 2 && out.manifest.counts.visuals === 3
    && out.manifest.counts.dashboards === 1 && out.manifest.counts.metrics === 6 && out.manifest.counts.alerts === 1
    && out.manifest.counts.versions >= 1, JSON.stringify(out.manifest.counts));
  ok('both Parquet files travel — the table AND the prepare source',
    names.includes(`datasets/${ds.id}.parquet`) && names.includes(`datasets/${ds.id}.source.parquet`));
  ok('no conversation, no trash, no config — only the whitelist',
    !names.some((n) => /copilot|trash|config/.test(n)), JSON.stringify(names.filter((n) => /copilot|trash|config/.test(n))));

  // ── 1 + 2. import on the same machine: every id collides ───────────────────
  const before = (await projects.listProjects()).length;
  const res = await bundle.importBundle(out.bytes);
  ok('import succeeds', res.ok === true, JSON.stringify(res).slice(0, 300));
  const np = res.project!;
  ok('…into a NEW project, named for the source', np.id !== pid && /^My project/.test(np.name), np.name);
  ok('…with the colliding ids remapped', (res.remapped || 0) >= 1 + 3 + 1 + 6 + 1, String(res.remapped));
  ok('…one more project on the machine', (await projects.listProjects()).length === before + 1);

  const nds = (await datasets.listDatasets(np.id))[0];
  ok('the dataset came across under a new id', !!nds && nds.id !== ds.id && nds.name === 'Retail orders');
  const nmeta = await datasets.getDatasetMeta(np.id, nds.id);
  ok('…with its pipeline', !!nmeta && JSON.stringify(nmeta.steps) === JSON.stringify(meta0!.steps));
  const rows = await datasets.getDataset(np.id, nds.id);
  ok('…and its table: every row reads back', !!rows && rows.rowCount === 5000 && rows.rows.length === 5000);
  const nvis = await visuals.listVisuals(np.id);
  ok('three visuals, all on the NEW dataset', nvis.length === 3 && nvis.every((v) => v.datasetId === nds.id));
  const nan = (await analysis.listAnalyses(np.id))[0];
  const na = await analysis.getAnalysis(np.id, nan.id);
  const cards = na!.sheets.flatMap((p) => p.cards);
  const control = cards.find((c) => c.type === 'control');
  ok('the dashboard\'s filter bar control points at the NEW dataset', !!control && control.control!.datasetId === nds.id);
  const visIds = new Set(nvis.map((v) => v.id));
  ok('…and every visual tile at a visual that exists in the new project',
    cards.filter((c) => c.type === 'visual').every((c) => visIds.has(c.visualId as string)));
  ok('six metrics on the new dataset', (await metrics.listMetrics(np.id)).every((m) => m.datasetId === nds.id));
  const rules = (await alertStore.load(np.id)).rules;
  ok('the alert rule came across, on the new dataset', rules.length === 1 && rules[0].datasetId === nds.id);
  ok('version history came across under the dashboard\'s new id', (await versions.list(np.id, 'dashboard', nan.id)).length >= 1);
  const text = allText(path.join(tmpUserData, 'projects', np.id));
  const srcIds = [pid, ds.id, seeded.analysisId, ...(await visuals.listVisuals(pid)).map((v) => v.id)];
  ok('no id from the source project survives anywhere in the copy', srcIds.every((id) => !text.includes(id)));
  ok('…and the source project is untouched', (await visuals.listVisuals(pid)).length === 3 && !!(await datasets.getDatasetMeta(pid, ds.id)));

  // Nothing collides once the source is gone: ids are kept as they were.
  await projects.deleteProject(pid);
  const again = await bundle.importBundle(out.bytes);
  ok('with nothing to collide with, ids are kept', again.ok && again.remapped === 0
    && !!(await datasets.getDatasetMeta(again.project!.id, ds.id)), JSON.stringify({ ok: again.ok, r: again.remapped }));

  // ── 3. whitelist ────────────────────────────────────────────────────────────
  const entries = bundle.readZip(out.bytes);
  const count0 = (await projects.listProjects()).length;
  for (const bad of ['copilot.json', '../escape.json', 'datasets/../../config.json', 'datasets/notes.txt', '/abs.json']) {
    const r = await bundle.importBundle(bundle.writeZip([...entries, { name: bad, data: Buffer.from('{}') }]));
    ok(`a bundle holding "${bad}" is refused whole`, r.ok === false && /refused|does not import/.test(r.error || ''), r.error);
  }
  ok('…and no refused import leaves a project behind', (await projects.listProjects()).length === count0);

  // ── 4. manifest ─────────────────────────────────────────────────────────────
  const firstVisual = entries.find((e) => e.name.startsWith('visuals/'));
  const dropped = entries.filter((e) => e !== firstVisual);
  const mismatch = await bundle.importBundle(bundle.writeZip(dropped));
  ok('a bundle missing a record its manifest lists is refused', !mismatch.ok && /manifest/.test(mismatch.error || ''), mismatch.error);
  const wrongFormat = entries.map((e) => e.name === 'manifest.json'
    ? { name: e.name, data: Buffer.from(JSON.stringify({ ...out.manifest, format: 'something-else' })) } : e);
  ok('a manifest of another format is refused', !(await bundle.importBundle(bundle.writeZip(wrongFormat))).ok);
  const damaged = Buffer.from(out.bytes);
  damaged[200] ^= 0xff;
  ok('a damaged bundle (CRC) is refused', !(await bundle.importBundle(damaged)).ok);
  ok('a file that is not a zip at all is refused', !(await bundle.importBundle(Buffer.from('hello'))).ok);
  ok('…still no stray project', (await projects.listProjects()).length === count0);

  // The zip itself round-trips arbitrary bytes, stored or deflated.
  const blob = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 256));
  const back = bundle.readZip(bundle.writeZip([{ name: 'a.bin', data: blob }, { name: 'b.txt', data: Buffer.from('x'.repeat(10000)) }]));
  ok('writeZip/readZip round-trip bytes exactly', Buffer.compare(back[0].data, blob) === 0 && back[1].data.length === 10000);

  // The async twins (the bundle JOB's path) are byte-identical to the sync ones,
  // report progress per entry, and a cancel thrown from the hook stops them.
  const when = new Date('2026-03-04T05:06:07Z');
  const pair = [{ name: 'a.bin', data: blob }, { name: 'b.txt', data: Buffer.from('x'.repeat(10000)) }];
  const ticks: number[] = [];
  const asyncZip = await bundle.writeZipAsync(pair, when, (done) => ticks.push(done));
  ok('writeZipAsync is byte-identical to writeZip', Buffer.compare(asyncZip, bundle.writeZip(pair, when)) === 0);
  ok('writeZipAsync reports one tick per entry', ticks.join(',') === '1,2');
  const asyncBack = await bundle.readZipAsync(asyncZip);
  ok('readZipAsync reads what readZip reads', asyncBack.length === 2 && Buffer.compare(asyncBack[0].data, blob) === 0);
  let stopped = false;
  try {
    await bundle.writeZipAsync(pair, when, () => { const e = new Error('Cancelled'); e.name = 'JobCancelled'; throw e; });
  } catch (e: any) { stopped = e && e.name === 'JobCancelled'; }
  ok('a cancel thrown between entries stops writeZipAsync', stopped);
  let importCancelled = false;
  try {
    await bundle.importBundle(out.bytes, { checkCancelled: () => { const e = new Error('Cancelled'); e.name = 'JobCancelled'; throw e; } });
  } catch (e: any) { importCancelled = e && e.name === 'JobCancelled'; }
  ok('a cancelled import rejects (JobCancelled) instead of reporting a bad bundle', importCancelled);
  ok('…and leaves no stray project', (await projects.listProjects()).length === count0);

  await everyProjectFile();
  finish();
}

// ── 5. every per-project file travels — and the salt never does ──────────────
// A backup IS a bundle, so a file the whitelist forgets is a file every backup
// silently loses. Written raw: the bundle is file-level, and these are the
// shapes the stores write (stories.ts, relationships.ts, catalog.ts,
// projectAssets.ts, projectBoundaries.ts, the privacy policy).
async function everyProjectFile(): Promise<void> {
  const p = await projects.createProject('Everything');
  const dir = path.join(tmpUserData, 'projects', p.id);
  const ds = '0b7c2c1e-0f4d-4c59-9d3b-2a8e6f1c0a11';
  const story = 'a1b2c3d4-0000-4000-8000-000000000001';
  const png = 'a1b2c3d4-0000-4000-8000-000000000002';
  const svg = 'a1b2c3d4-0000-4000-8000-000000000003';
  const geo = 'a1b2c3d4-0000-4000-8000-000000000004';
  const put = (rel: string, data: string | Buffer): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  };
  // The PNG's bytes spell a record id: if import ever rewrote a binary body,
  // this is the byte that would change.
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]), Buffer.from(story)]);
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-id="${story}"/>`;
  put(`stories/${story}.json`, JSON.stringify({ id: story, name: 'Q3 story', slides: [{ datasetId: ds }] }));
  put('relationships.json', JSON.stringify({ relationships: [{ from: { datasetId: ds }, to: { datasetId: ds } }] }));
  put('catalog.json', JSON.stringify({ tags: ['finance'], entries: { [`dataset:${ds}`]: { tags: ['finance'] } } }));
  put(`assets/${png}.png`, pngBytes);
  put(`assets/${svg}.svg`, svgText);
  put(`boundaries/${geo}.json`, JSON.stringify({ id: geo, name: 'Regions', type: 'FeatureCollection', features: [] }));
  put('privacy/policy.json', JSON.stringify({ mode: 'hash', columns: {} }));
  put('privacy/salt.key', 'a-per-project-secret-that-must-stay-home');
  put('lock.json', JSON.stringify({ app: 'Ordinate', host: 'x' }));

  const out = await bundle.exportProject(p.id);
  if (!out) throw new Error('export returned nothing');
  const names = bundle.readZip(out.bytes).map((e) => e.name);
  for (const want of [`stories/${story}.json`, 'relationships.json', 'catalog.json', `assets/${png}.png`, `assets/${svg}.svg`,
    `boundaries/${geo}.json`, 'privacy/policy.json']) {
    ok(`the bundle carries ${want}`, names.includes(want), JSON.stringify(names));
  }
  ok('privacy/salt.key NEVER leaves the project folder', !names.some((n) => /salt/.test(n)) && !out.bytes.includes(Buffer.from('a-per-project-secret')));
  ok('…nor does a synced project\'s lock.json', !names.includes('lock.json'));
  ok('the manifest counts stories, assets and boundaries',
    out.manifest.counts.stories === 1 && out.manifest.counts.assets === 2 && out.manifest.counts.boundaries === 1, JSON.stringify(out.manifest.counts));

  // Same machine: the story id collides and is remapped — in names and JSON
  // bodies — while the image bytes that spell it are left exactly as they were.
  const res = await bundle.importBundle(out.bytes);
  ok('a bundle holding all of them imports', res.ok === true, res.error);
  const ndir = path.join(tmpUserData, 'projects', res.project!.id);
  const nstory = fs.readdirSync(path.join(ndir, 'stories'))[0];
  ok('the story came across under a new id', !!nstory && nstory !== `${story}.json`, nstory);
  ok('relationships.json, catalog.json and the policy came across',
    ['relationships.json', 'catalog.json', 'privacy/policy.json'].every((f) => fs.existsSync(path.join(ndir, f))));
  const nassets = fs.readdirSync(path.join(ndir, 'assets')).sort();
  const npng = nassets.find((n) => n.endsWith('.png'))!;
  const nsvg = nassets.find((n) => n.endsWith('.svg'))!;
  ok('a binary asset is byte-for-byte the same, id-shaped bytes and all',
    Buffer.compare(fs.readFileSync(path.join(ndir, 'assets', npng)), pngBytes) === 0);
  ok('…and so is an SVG (not .json, so never rewritten)', fs.readFileSync(path.join(ndir, 'assets', nsvg), 'utf8') === svgText);
  ok('the boundary came across', fs.readdirSync(path.join(ndir, 'boundaries')).length === 1);
  ok('no salt was created by the import', !fs.existsSync(path.join(ndir, 'privacy', 'salt.key')));

  // A crafted bundle that DOES carry a salt is refused whole, like any stranger.
  const withSalt = bundle.writeZip([...bundle.readZip(out.bytes), { name: 'privacy/salt.key', data: Buffer.from('x') }]);
  const refused = await bundle.importBundle(withSalt);
  ok('a bundle carrying privacy/salt.key is refused', !refused.ok && /refused|does not import/.test(refused.error || ''), refused.error);
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
