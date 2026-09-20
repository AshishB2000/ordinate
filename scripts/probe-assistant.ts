// PROBE: the assistant loop against the USER'S REAL MODEL.
//
// scripts/smoke-assistant.ts proves the loop works when the model returns
// exactly the JSON our parsers expect. It cannot prove the loop works, because
// it writes the model's side of the conversation itself. The open risk is the
// only one that matters in production: a real model paraphrases a column name,
// wraps its action line in a fenced block, adds a trailing sentence, or invents
// a chart id — and the builder that passes every test looks broken on the first
// real ask.
//
// This is a MANUAL, KEY-BEARING run. It is deliberately named probe-* so that
// neither `npm test` (globs scripts/test-*.js) nor scripts/run-smokes.ts (an
// explicit list) can pick it up. It never runs in CI, and it must not: it costs
// real model calls and its results are not deterministic.
//
//   node scripts/probe-assistant.js            # 3 runs (default)
//   PROBE_RUNS=1 node scripts/probe-assistant.js
//
// It copies ONLY the execution fields of the real config — executionMode,
// localCli, byok — into a throwaway --user-data-dir, so the walk gets the real
// model and touches none of the user's projects. No key is ever printed, logged
// or written to the evidence files; `redact` runs over every dump.
//
// The two capture seams, both reached through the module object at call time so
// nothing in src/ changes to observe them:
//
//   localCliRun.runLocalCli / analyzeStream.streamProvider  → the RAW reply
//   analyze.askCopilot / draftDashboard / dispatch          → the PARSED result
//
// Evidence lands in docs/assistant-probe/. That directory is the point of the
// exercise: it is what the model actually said, not what we hoped it would.

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const EVIDENCE = path.join(REPO, 'docs', 'assistant-probe');
const RUNS = Math.max(1, Number(process.env.PROBE_RUNS || 3));

/** The real app's userData, by platform. productName is still "Screenchart". */
function realUserData(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Screenchart');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Screenchart');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Screenchart');
}

/** Deep clone with every credential-shaped value replaced. Applied to EVERY
 *  dump, not just the config one — a model reply could quote a key back. */
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = /apikey|api_key|token|password|secret/i.test(k) && val ? '[redacted]' : redact(val);
    }
    return out;
  }
  if (typeof v === 'string') {
    // Belt and braces: a key pasted into prose is still a key.
    return v.replace(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[redacted]');
  }
  return v;
}

interface StepRecord {
  run: number;
  step: string;
  ask: string;
  raw: string;
  parsed: unknown;
  uiOk: boolean;
  notes: string[];
}

async function main(): Promise<void> {
  // ── Is a model configured at all? ────────────────────────────────────────
  const cfgPath = path.join(realUserData(), 'config.json');
  if (!fs.existsSync(cfgPath)) {
    console.log('No Ordinate config found at ' + cfgPath + ' — set the Assistant up in Settings → Assistant first.');
    return;
  }
  let real: any;
  try { real = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { real = {}; }

  const byok = real.byok || {};
  const byokReady = Object.values(byok.providers || {})
    .some((p: any) => p && p.apiKey && p.verified);
  const cli = real.localCli || {};
  const detected = (cli.lastDetection && cli.lastDetection.results) || [];
  const cliReady = Boolean(cli.activeId)
    && detected.some((r: any) => r && r.id === cli.activeId && r.status === 'installed');
  if (!byokReady && !cliReady) {
    console.log('No verified BYOK provider and no installed local CLI — set one up in Settings → Assistant, then re-run.');
    return;
  }
  const modelLabel = real.executionMode === 'local' ? 'local CLI: ' + cli.activeId : 'BYOK: ' + byok.activeProvider;
  console.log(`Probing the assistant loop against the REAL model (${modelLabel}), ${RUNS} run(s).\n`);

  fs.mkdirSync(EVIDENCE, { recursive: true });
  const all: StepRecord[] = [];

  for (let run = 1; run <= RUNS; run += 1) {
    console.log(`\n──────── run ${run} of ${RUNS} ────────`);
    const records = await oneRun(run, real);
    all.push(...records);
  }

  // ── The summary table the PR body needs ──────────────────────────────────
  console.log('\n\n=== 15-call summary (run × step) ===');
  const steps = ['1-chat', '2-draft', '3-edit', '4-style', '5-persist'];
  console.log('step        ' + Array.from({ length: RUNS }, (_, i) => 'run' + (i + 1)).join('  '));
  for (const s of steps) {
    const cells = Array.from({ length: RUNS }, (_, i) => {
      const r = all.find((x) => x.run === i + 1 && x.step === s);
      return r ? (r.uiOk ? ' ok ' : 'FAIL') : ' —  ';
    });
    console.log(s.padEnd(12) + cells.join('  '));
  }
  const failures = all.filter((r) => !r.uiOk);
  for (const f of failures) {
    console.log(`\nrun ${f.run} ${f.step}: ${f.notes.join('; ')}`);
  }
  fs.writeFileSync(path.join(EVIDENCE, 'summary.json'),
    JSON.stringify(redact({ modelLabel, runs: RUNS, records: all }), null, 2));
  console.log('\nEvidence: ' + path.relative(REPO, EVIDENCE));

  ok('every model call produced a working UI step', failures.length === 0,
    `${failures.length} of ${all.length} failed`);
  if (failureCount()) process.exit(1);
}

async function oneRun(run: number, realCfg: any): Promise<StepRecord[]> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `ordinate-probe-${run}-`));
  // ONLY the execution fields. The user's projects, history, starred pins and
  // window state stay where they are and are never read.
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    executionMode: realCfg.executionMode,
    localCli: realCfg.localCli,
    byok: realCfg.byok,
  }, null, 2));

  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO,
    timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');
  const errors: string[] = [];
  win.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });

  // ── Wrap, never replace ──────────────────────────────────────────────────
  await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analyze = req('./src/ai/analyze.js');
    const localCliRun = req('./src/cli/localCliRun.js');
    const g = globalThis as any;
    g.__probe = { raw: [] as any[], parsed: [] as any[] };

    // RAW. dispatch() picks a transport; both are reached through the module
    // object, so the real reply text is observable without touching src/.
    const realRun = localCliRun.runLocalCli;
    localCliRun.runLocalCli = async (...a: any[]) => {
      const res = await realRun(...a);
      g.__probe.raw.push({ via: 'localCli', rawText: res && res.rawText, error: res && res.error });
      return res;
    };

    const wrap = (name: string): void => {
      const realFn = analyze[name];
      analyze[name] = async (...a: any[]) => {
        const res = await realFn(...a);
        g.__probe.parsed.push({ fn: name, result: res });
        return res;
      };
    };
    wrap('askCopilot');
    wrap('draftDashboard');
    wrap('dispatch');
  });

  const killSplash = (): Promise<void> => win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  await win.waitForTimeout(4000);
  await killSplash();

  const seeded = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    for (const p of await projects.listProjects()) {
      const ds = await datasets.listDatasets(p.id);
      if (ds.some((d: any) => /retail/i.test(String(d.name)))) return p.id;
    }
    return '';
  });
  await win.evaluate(async (id: string) => { await (window as any).adoptProject(id); }, seeded);
  await win.waitForTimeout(1500);
  await win.evaluate(() => {
    const b = document.getElementById('side-ai-btn') as HTMLElement | null;
    if (b) b.click();
  });
  await win.waitForTimeout(800);

  const records: StepRecord[] = [];
  const drain = async (): Promise<{ raw: any[]; parsed: any[] }> =>
    app.evaluate(() => {
      const g = globalThis as any;
      const out = { raw: g.__probe.raw.slice(), parsed: g.__probe.parsed.slice() };
      g.__probe.raw.length = 0;
      g.__probe.parsed.length = 0;
      return out;
    });

  /**
   * Send one message and wait for the model to actually answer.
   *
   * Both halves are load-bearing against a REAL model, which takes tens of
   * seconds rather than the milliseconds a stub takes:
   *
   *  - dkSend() returns immediately when `dkBusy`, so typing the next question
   *    while the previous answer is still in flight DROPS IT SILENTLY. The first
   *    version of this probe did exactly that and reported "no proposal card"
   *    for a question the model was never asked.
   *  - The answer bubble is rendered from the stream, so it appears BEFORE
   *    askCopilot resolves. Waiting on the bubble and then draining captures the
   *    previous turn's reply, not this one.
   *
   * So: wait for idle, send, then wait for a new capture in MAIN.
   */
  const ask = async (text: string): Promise<boolean> => {
    const idle = await waitFor(async () => win.evaluate(
      () => typeof (globalThis as any).dkBusy === 'undefined' || (globalThis as any).dkBusy === false,
    ), 120_000);
    if (!idle) return false;
    const before = await app.evaluate(() => (globalThis as any).__probe.parsed.length);
    await win.evaluate((t: string) => {
      const input = document.getElementById('dk-input') as HTMLTextAreaElement;
      input.value = t;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }, text);
    await win.keyboard.press('Enter');
    return waitFor(async () => app.evaluate(
      (_a: any, n: number) => (globalThis as any).__probe.parsed.length > n, before,
    ), 300_000);
  };

  /** A real model is slow and variable — poll rather than sleep a fixed time. */
  const waitFor = async (fn: () => Promise<boolean>, ms = 180_000): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await fn().catch(() => false)) return true;
      await win.waitForTimeout(1500);
    }
    return false;
  };

  const record = async (step: string, askText: string, uiOk: boolean, notes: string[]): Promise<void> => {
    const cap = await drain();
    const rec: StepRecord = {
      run, step, ask: askText,
      raw: cap.raw.map((r) => String(r.rawText || '')).join('\n---\n'),
      parsed: cap.parsed,
      uiOk, notes,
    };
    records.push(rec);
    fs.writeFileSync(path.join(EVIDENCE, `run${run}-${step}.json`),
      JSON.stringify(redact(rec), null, 2));
    console.log(`  ${uiOk ? 'ok  ' : 'FAIL'} ${step}${notes.length ? '  — ' + notes.join('; ') : ''}`);
  };

  // ── 1. plain chat ────────────────────────────────────────────────────────
  const q1 = 'hi';
  const replied1 = await ask(q1);
  const gotBubble = await waitFor(async () => win.evaluate(() =>
    document.querySelectorAll('#dk-messages .xp-msg-assistant .xp-bubble').length >= 1));
  const bubble = await win.evaluate(() => {
    const b = [...document.querySelectorAll('#dk-messages .xp-msg-assistant .xp-bubble')];
    return (b[b.length - 1]?.textContent || '').trim();
  });
  const leaked = /@@ACTION|"kind"\s*:/.test(bubble);
  await record('1-chat', q1, replied1 && gotBubble && !leaked,
    [!replied1 && 'the model never replied', !gotBubble && 'no answer bubble',
      leaked && 'action line leaked into the answer'].filter(Boolean) as string[]);

  // ── 2. draft → Build ─────────────────────────────────────────────────────
  const q2 = 'build me a dashboard of revenue by region and month with a units KPI';
  const replied2 = await ask(q2);
  const gotCard = await waitFor(async () => win.evaluate(() =>
    document.querySelectorAll('#dk-messages .dk-proposal').length >= 1));
  let built = false;
  const notes2: string[] = [];
  if (!replied2) notes2.push('the model never replied');
  if (!gotCard) {
    notes2.push('no dashboard proposal card appeared');
  } else {
    const dropped = await win.evaluate(() => {
      const cards = [...document.querySelectorAll('#dk-messages .dk-proposal')];
      const c = cards[cards.length - 1] as HTMLElement;
      const drops = [...c.querySelectorAll('.an-draft-dropped li, .an-draft-dropped div')]
        .map((d) => (d.textContent || '').trim()).filter(Boolean);
      const tiles = c.querySelectorAll('.an-draft-visual').length;
      const btn = [...c.querySelectorAll('button')].find((b) => /build|create/i.test(b.textContent || ''));
      if (btn) (btn as HTMLElement).click();
      return { drops, tiles, clicked: !!btn };
    });
    if (dropped.drops.length) notes2.push('validator dropped: ' + dropped.drops.join(' | '));
    if (!dropped.tiles) notes2.push('card previewed no tiles');
    built = await waitFor(async () => win.evaluate(() =>
      document.querySelectorAll('#dash-grid .dash-card').length >= 2));
    if (!built) notes2.push('Build did not open a dashboard with tiles');
  }
  await record('2-draft', q2, replied2 && gotCard && built && notes2.length === 0, notes2);

  // ── 3. edit → Apply ──────────────────────────────────────────────────────
  const q3 = 'add a KPI for average discount';
  const beforeMetrics = await win.evaluate(() =>
    document.querySelectorAll('#dash-grid .dash-card--metric').length);
  const replied3 = await ask(q3);
  const notes3: string[] = [];
  const gotEdit = await waitFor(async () => win.evaluate((n: number) => {
    const cards = [...document.querySelectorAll('#dk-messages .dk-proposal')];
    const c = cards[cards.length - 1] as HTMLElement | undefined;
    return !!c && /suggested change/i.test(c.textContent || '') && n >= 0;
  }, beforeMetrics));
  let applied = false;
  if (!replied3) notes3.push('the model never replied');
  if (!gotEdit) {
    notes3.push('no edit proposal card appeared');
  } else {
    const info = await win.evaluate(() => {
      const cards = [...document.querySelectorAll('#dk-messages .dk-proposal')];
      const c = cards[cards.length - 1] as HTMLElement;
      const drops = [...c.querySelectorAll('.an-draft-dropped, .dk-delta-dropped')]
        .map((d) => (d.textContent || '').trim()).filter(Boolean);
      const btn = [...c.querySelectorAll('button')].find((b) => /apply/i.test(b.textContent || ''));
      if (btn) (btn as HTMLElement).click();
      return { drops, clicked: !!btn };
    });
    if (info.drops.length) notes3.push('delta dropped: ' + info.drops.join(' | ').slice(0, 200));
    if (!info.clicked) notes3.push('card had no Apply button');
    applied = await waitFor(async () => win.evaluate((n: number) =>
      document.querySelectorAll('#dash-grid .dash-card--metric').length > n, beforeMetrics), 60_000);
    if (!applied) notes3.push('Apply added no KPI tile');
  }
  await record('3-edit', q3, replied3 && gotEdit && applied && notes3.length === 0, notes3);

  // ── 4. style → Apply ─────────────────────────────────────────────────────
  const q4 = 'make it dark';
  const replied4 = await ask(q4);
  const notes4: string[] = [];
  const gotStyle = await waitFor(async () => win.evaluate(() => {
    const cards = [...document.querySelectorAll('#dk-messages .dk-proposal')];
    const c = cards[cards.length - 1] as HTMLElement | undefined;
    return !!c && /restyle/i.test(c.textContent || '');
  }));
  let dark = false;
  if (!replied4) notes4.push('the model never replied');
  if (!gotStyle) {
    notes4.push('no style card appeared');
  } else {
    await win.evaluate(() => {
      const cards = [...document.querySelectorAll('#dk-messages .dk-proposal')];
      const c = cards[cards.length - 1] as HTMLElement;
      const btn = [...c.querySelectorAll('button')].find((b) => /apply/i.test(b.textContent || ''));
      if (btn) (btn as HTMLElement).click();
    });
    dark = await waitFor(async () => win.evaluate(() => {
      const ed = document.getElementById('dash-editor');
      return !!ed && /dash-theme--dark/.test(ed.className);
    }), 30_000);
    if (!dark) notes4.push('style not applied to the open dashboard');
  }
  await record('4-style', q4, replied4 && gotStyle && dark, notes4);

  // ── 5. persistence ───────────────────────────────────────────────────────
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(4000);
  await killSplash();
  const persisted = await app.evaluate(async (_a: any, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const list = await analysis.listAnalyses(pid);
    if (!list.length) return { tiles: 0, theme: '' };
    const rec = await analysis.getAnalysis(pid, list[0].id);
    return { tiles: rec.sheets[0].cards.length, theme: rec.style && rec.style.theme };
  }, seeded);
  await record('5-persist', '(reload)', persisted.tiles >= 2,
    persisted.tiles >= 2 ? [] : ['nothing persisted: ' + JSON.stringify(persisted)]);

  if (errors.length) console.log('  renderer console errors: ' + errors.slice(0, 3).join(' | '));
  await app.close();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
  return records;
}

main().catch((err) => { console.error(err); process.exit(1); });
