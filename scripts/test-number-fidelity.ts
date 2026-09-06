// THE GATE: does the Assistant only state figures the app computed?
//
// Two modes, and they answer different questions.
//
// FIXTURE MODE (default, and what CI runs) replays recorded answer + ledger
// pairs through `auditNumbers`. It is deterministic, needs no model, and is
// fast. What it protects is the AUDIT: if a future change to the extractor
// starts missing a derived percentage, or starts accusing a year, these cases
// go red. It cannot tell you whether today's prompt actually produces clean
// answers — no fixture can, because a fixture is a recording of an answer that
// already happened.
//
// LIVE MODE (ORDINATE_LIVE_MODEL=1, plus a configured execution path) asks a
// real model real questions over a real dataset and audits what comes back.
// That is the only thing that measures the PROMPT. It is off by default because
// it needs a CLI on the machine, costs seconds per question, and is not
// deterministic — three properties CI must not have.
//
// The live run is not decoration: the fixtures in ./number-fidelity-cases.ts
// marked `recorded: true` are transcripts FROM it, so the deterministic suite is
// anchored to answers a model really gave rather than to answers an author
// imagined a model might give.
//
//   node scripts/test-number-fidelity.js
//   ORDINATE_LIVE_MODEL=1 node scripts/test-number-fidelity.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';
import { FIDELITY_CASES } from './number-fidelity-cases';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const LIVE = process.env.ORDINATE_LIVE_MODEL === '1';

// A temp userData either way — nothing here writes to the user's real profile.
// In LIVE mode the real config.json is COPIED in (not pointed at), because
// `execConfig.executionReady()` reads the active CLI and its saved detection result
// from that file and there is no other way to reach a configured model. A copy,
// so a bug in this script cannot corrupt the user's settings, and the seeded
// project lands in the temp dir where it belongs.
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-fidelity-'));
if (LIVE) {
  const real = path.join(os.homedir(), 'Library', 'Application Support', 'Screenchart', 'config.json');
  const copy = path.join(tmpUserData, 'config.json');
  if (fs.existsSync(real)) {
    fs.copyFileSync(real, copy);
    // ORDINATE_LIVE_CLI runs the gate against a specific local CLI instead of
    // whichever one the user happens to have active. This is not a convenience:
    // the CLIs differ enormously in how well they hold a prose-plus-action
    // contract, so "did the prompt hold?" is only a meaningful question once you
    // can say which model was asked. Written into the COPY, never the original.
    const want = process.env.ORDINATE_LIVE_CLI;
    if (want) {
      const cfg = JSON.parse(fs.readFileSync(copy, 'utf8'));
      cfg.localCli = { ...(cfg.localCli || {}), activeId: want };
      cfg.executionMode = 'local';
      fs.writeFileSync(copy, JSON.stringify(cfg, null, 2));
    }
  }
}

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_name: string) => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources under test.
const { auditNumbers }: typeof import('../src/ai/numberAudit') = require('../src/ai/numberAudit');
type LedgerEntry = import('../src/ai/numberAudit').LedgerEntry;

// ── Fixture mode ─────────────────────────────────────────────────────────────

function runFixtures(): void {
  for (const c of FIDELITY_CASES) {
    const r = auditNumbers(c.answer, c.ledger as LedgerEntry[]);
    const got = r.violations.map((v) => v.token).sort();
    const want = [...c.violations].sort();
    ok(
      `${c.recorded ? '[recorded] ' : '[written] '}${c.name}`,
      got.length === want.length && got.every((t, i) => t === want[i]),
      `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
    );
  }
  ok('the fixture corpus is large enough to be a corpus', FIDELITY_CASES.length >= 20,
    FIDELITY_CASES.length + ' cases');
  ok('the corpus contains real recorded model answers, not only written ones',
    FIDELITY_CASES.some((c) => c.recorded));
}

// ── Live mode ────────────────────────────────────────────────────────────────
//
// The twelve questions deliberately span three kinds:
//   STATS       — answerable straight off the facts block.
//   COMPARISON  — answerable only by reading several app-computed figures
//                 against each other, which is narration, not arithmetic.
//   TRAP        — NOT answerable without deriving a figure the ledger lacks.
//                 The right answer is to say so. A model that obliges instead is
//                 exactly what this gate exists to catch, and the fix is always
//                 to compute the figure app-side and put it in the ledger —
//                 never to add "be careful" to the prompt.
const LIVE_QUESTIONS: { kind: 'stats' | 'comparison' | 'trap'; q: string }[] = [
  { kind: 'stats', q: 'How many rows does this dataset have?' },
  { kind: 'stats', q: 'What is the average order value?' },
  { kind: 'stats', q: 'What is the largest single order amount?' },
  { kind: 'stats', q: 'How many distinct regions are there?' },
  { kind: 'stats', q: 'What is the average order value by region?' },
  { kind: 'comparison', q: 'Which month dropped the most?' },
  { kind: 'comparison', q: 'Which region is furthest below the overall average?' },
  { kind: 'comparison', q: 'Rank the regions by total amount.' },
  { kind: 'comparison', q: 'Compare the first month with the last month.' },
  { kind: 'trap', q: 'What percent did revenue grow over the period?' },
  { kind: 'trap', q: 'What share of the total does the biggest region represent?' },
  { kind: 'trap', q: 'What is the median order amount?' },
];

// Deterministic, and shaped for the questions above: a text dimension to group
// by, a date column so "which month" is askable, and an amount to aggregate.
// 364 rows, one per day, so every month is present and no month is a partial.
function seedRows(): (string | number)[][] {
  const regions = ['North', 'South', 'East', 'West'];
  const rows: (string | number)[][] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 364; i += 1) {
    const d = new Date(start + i * 86400000);
    rows.push([
      d.toISOString().slice(0, 10),
      regions[i % regions.length],
      // A gentle seasonal shape with a real dip, so "which month dropped most"
      // has an answer the app can compute and the model can only narrate.
      100 + ((i * 7) % 53) - (d.getUTCMonth() === 8 ? 40 : 0),
    ]);
  }
  return rows;
}

async function runLive(): Promise<void> {
  const config: typeof import('../src/app/config') = require('../src/app/config');
  const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
  const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');

  ok('LIVE: an execution path is configured', execConfig.executionReady(),
    'set one up in Settings → Execution, or run without ORDINATE_LIVE_MODEL=1');
  if (!execConfig.executionReady()) return;
  const mode = config.get().executionMode || 'local';
  console.log(`\nLIVE MODE — execution ${mode}` +
    (mode === 'local' ? ` (${config.get().localCli.activeId})` : '') + '\n');

  await projects.init();
  const proj = await projects.createProject('Number fidelity');
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Orders',
    sourceKind: 'csv',
    columns: [
      { name: 'order_date', type: 'date' },
      { name: 'region', type: 'text' },
      { name: 'amount', type: 'number' },
    ],
    rows: seedRows(),
  } as any);
  ok('LIVE: seeded the sample dataset', !!ds && ds.rowCount === 364, ds ? ds.rowCount : 'not saved');
  if (!ds) return;

  const facts = await ipcCopilot.buildFacts(proj.id, { kind: 'dataset', id: ds.id });
  console.log(`Ledger: ${facts.ledger.length} app-computed figures.\n`);

  for (const { kind, q } of LIVE_QUESTIONS) {
    const res = await analyze.askCopilot([], facts.text, q);
    if (!res.ok) {
      ok(`LIVE [${kind}] ${q}`, false, 'model error: ' + (res as any).message);
      continue;
    }
    // BEFORE auditing: is this an answer at all?
    //
    // The audit's verdict on a non-answer is "clean", because a string with no
    // figures in it states no wrong figure — so without this check a model that
    // returns nothing useful scores a perfect pass and the gate reports success
    // while measuring nothing. That is exactly what the first live run of this
    // file did (one CLI echoed the bare action JSON, `{"kind":"none",...}`, for
    // all twelve questions and every one came back green). A gate that cannot
    // fail is worse than no gate: it is a false assurance in CI's voice.
    const prose = res.text.trim();
    const isAnswer = prose.length > 20 && !/^[[{]/.test(prose);
    ok(`LIVE [${kind}] ${q} — returned prose, not a marker or a stub`, isAnswer,
      JSON.stringify(prose.slice(0, 120)));
    if (!isAnswer) continue;

    const a = auditNumbers(res.text, facts.ledger);
    // The transcript the PR carries. Printed for EVERY question, pass or fail:
    // a gate you only see when it breaks teaches nothing about the answers it
    // let through.
    console.log('─'.repeat(72));
    console.log(`[${kind}] ${q}`);
    console.log(res.text.trim());
    if (!a.ok) {
      console.log('\nVIOLATIONS:');
      for (const v of a.violations) {
        console.log(`  ${v.token}  (nearest ledger figure: ` +
          (v.nearest ? `"${v.nearest.label}" = ${v.nearest.value}, delta ${v.delta}` : 'none') + ')');
      }
      console.log('\nLEDGER:');
      for (const e of facts.ledger) console.log(`  ${e.label} = ${e.value} [${e.unit}] ${e.source}`);
    }
    console.log('');
    ok(`LIVE [${kind}] ${q}`, a.ok, a.violations.map((v) => v.token).join(', '));
  }
}

async function main(): Promise<void> {
  runFixtures();
  if (LIVE) await runLive();
  else console.log('\n(live mode off — set ORDINATE_LIVE_MODEL=1 with a configured model to run it)');
  console.log(failureCount() === 0 ? '\nAll number-fidelity checks passed.' : '\nnumber-fidelity checks FAILED.');
  finish();
}

void main();
