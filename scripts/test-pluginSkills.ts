// Self-check for the Ordinate plugin (plugins/ordinate/): its skills teach an
// outside agent the shapes the MCP tools accept, so this keeps them honest
// against the real validator, on the real sample project, through
// `registry.dispatch` (the one entry point /api/mcp uses).
//
//   • build-dashboard's example plan builds with NOTHING dropped.
//     NEGATIVE CONTROL: the same plan with a sum over a text column loses that tile.
//   • build-dashboard's chart-type list is exactly the app's CHART_TYPE_IDS.
//   • answer-data-questions' example calls run, and the figures it quotes are
//     the ones those calls return (formatted as the skill says to).
//   • The manifests parse, and every skill's `name:` is its folder name.
//
//   npm run build:ts && node scripts/test-pluginSkills.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-plugin-skills-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const reg: typeof import('../src/automation/registry') = require('../src/automation/registry');
const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');
// The search index is written on a timer after the seed; not needed here.
(require('../src/engine/dataSearchResident') as { scheduleIndex: () => void }).scheduleIndex = () => undefined;

const PLUGIN = path.join(__dirname, '..', 'plugins', 'ordinate');
const skill = (name: string): string => fs.readFileSync(path.join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8');

// `any`: a tool reply is JSON the checks below read field by field.
async function call(tool: string, args: Record<string, unknown>): Promise<any> {
  const cmd = reg.findTool(tool);
  if (!cmd) throw new Error('no tool ' + tool);
  return reg.dispatch(cmd, args, { transport: 'stdio', cwd: tmp, headless: true });
}

/** Backticked tokens in a piece of Markdown. */
const ticks = (s: string): string[] => [...s.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);

/** The chart types the skill lists: the table's chartType column plus the "Other valid types" paragraph. */
function listedChartTypes(md: string): Set<string> {
  const section = md.slice(md.indexOf('## Picking the chart'), md.indexOf('## What a plan cannot do'));
  const out = new Set<string>();
  for (const line of section.split('\n')) {
    const cells = line.split('|');
    if (line.startsWith('|') && !line.startsWith('|---') && !line.startsWith('| The question')) ticks(cells[2] ?? '').forEach((t) => out.add(t));
  }
  const other = section.slice(section.indexOf('Other valid types:'));
  ticks(other.slice(0, other.indexOf('\n\n'))).forEach((t) => out.add(t));
  return out;
}

const sameSet = (a: Set<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

async function main(): Promise<void> {
  // ── manifests ──
  const market = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  const entry = market.plugins.find((p: { name: string }) => p.name === 'ordinate');
  ok('marketplace: lists the ordinate plugin at plugins/ordinate', entry && path.resolve(__dirname, '..', entry.source) === PLUGIN);
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  ok('plugin.json: named ordinate', manifest.name === 'ordinate');
  const mcp = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8'));
  ok('.mcp.json: HTTP to ${ORDINATE_URL}/api/mcp with the token from the environment',
    mcp.ordinate.type === 'http' && mcp.ordinate.url === '${ORDINATE_URL}/api/mcp' && mcp.ordinate.headers.Authorization === 'Bearer ${ORDINATE_TOKEN}');
  for (const dir of fs.readdirSync(path.join(PLUGIN, 'skills'))) {
    ok(`skill ${dir}: name matches its folder`, new RegExp(`^---\\nname: ${dir}\\n`).test(skill(dir)));
  }

  // ── build-dashboard ──
  const build = skill('build-dashboard');
  const listed = listedChartTypes(build);
  ok('build-dashboard: lists exactly the app\'s chart types', sameSet(listed, plan.CHART_TYPE_IDS),
    { missing: [...plan.CHART_TYPE_IDS].filter((t) => !listed.has(t)), extra: [...listed].filter((t) => !plan.CHART_TYPE_IDS.has(t)) });
  ok('negative control: a list missing one type is caught', !sameSet(new Set([...listed].slice(1)), plan.CHART_TYPE_IDS));

  await sample.seedSampleProject();
  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(build)![1]!);
  const built = await call('create_dashboard', { plan: example });
  ok('build-dashboard: the example plan builds with nothing dropped', built.dropped.length === 0, built.dropped);
  ok('build-dashboard: every example chart was made', built.visualIds.length === example.sheets[0].visuals.length);

  const broken = structuredClone(example);
  broken.sheets[0].metrics.push({ dataset: 'Retail orders', column: 'region', aggregation: 'sum', label: 'Bad' });
  const lost = await call('create_dashboard', { plan: broken });
  ok('negative control: a sum over a text column is dropped, with the reason',
    lost.dropped.length === 1 && /needs a number column/.test(lost.dropped[0].message), lost.dropped);

  // ── answer-data-questions ──
  const answer = skill('answer-data-questions');
  const aggArgs = JSON.parse(/- `aggregate`: `(\{.*\})`/.exec(answer)![1]!);
  const sql = /- `query_sql`: `(SELECT[^`]+)`/.exec(answer)![1]!;
  const agg = await call('aggregate', aggArgs);
  const west = agg.series[0].values[agg.labels.indexOf('West')];
  const quotedWest = /West leads with ([\d,.]+)/.exec(answer)![1];
  ok('answer-data-questions: West\'s quoted profit is aggregate\'s, noise dropped',
    quotedWest === Number(west.toFixed(2)).toLocaleString('en-US', { minimumFractionDigits: 2 }), { quotedWest, west });
  const rows = (await call('query_sql', { sql })).rows as Array<[string, number]>;
  const quotedNe = /Northeast leads at ([\d.]+)%/.exec(answer)![1];
  ok('answer-data-questions: the example SQL runs and Northeast leads at the quoted margin',
    rows[0]![0] === 'Northeast' && String(rows[0]![1]) === quotedNe, { rows, quotedNe });
}

main()
  .catch((e) => ok('no unexpected throw', false, e && e.stack))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    finish();
  });
