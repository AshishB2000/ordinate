// The ASSISTANT LOOP, end to end, in the real app.
//
// Every other assistant smoke calls the proposal renderers DIRECTLY with a
// fixture (smoke-dock, smoke-ask-actions) or stubs one handler in the middle
// (smoke-dashboard-edit). None of them has ever driven the actual chain a user
// walks: type in the dock → an answer carrying an action line → a proposal card
// → Build → a dashboard opens → "add a KPI" → the edit lands on disk. That chain
// is the product's headline feature and it was unverified.
//
// The model is stubbed at its OWN boundary and nowhere else, so everything after
// the reply is shipped code: the action-line parser, the plan validator,
// buildPlan, the delta validator, the renderer's card wiring and every record
// write. Three seams, all reached through the module object at call time:
//
//   analyze.askCopilot      ← src/ipc/copilot.ts   (the dock's answer)
//   analyze.draftDashboard  ← src/ipc/analyses.ts  (the plan behind a proposal)
//   analyze.dispatch        ← src/ipc/analyses.ts  (the edit delta)
//
// NOTE on the third: inside analyze.js every internal `dispatch(...)` is a
// CAPTURED LOCAL, so patching analyze.dispatch reaches draftDashboardEdit and
// nothing else. That is why askCopilot and draftDashboard are patched by name
// rather than relying on one dispatch stub to cover them.
//
// Readiness is real config, not a stub: a fake BYOK key is written through the
// same setters Settings uses, so executionReady() is true for the reason it
// would be in production. Nothing reaches the network — electron's net.request
// is replaced with a throwing counter and asserted at zero.
//
// NOT covered here: streaming token-by-token rendering (the stub delivers the
// answer in one delta), thread switching, and any real model output — what a
// model actually replies is test-suggestedAction.ts's job, not this file's.

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-assistant-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

/** The plan the stubbed draft returns: two charts and one KPI over the sample. */
const PLAN = {
  name: 'Revenue overview',
  rationale: 'Revenue by region and by category, with a units KPI.',
  calculatedFields: [],
  sheets: [{
    name: 'Overview',
    metrics: [{ dataset: 'Retail orders', column: 'units', aggregation: 'sum', label: 'Units sold' }],
    visuals: [
      { dataset: 'Retail orders', name: 'Revenue by region', chartType: 'column',
        encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } },
      { dataset: 'Retail orders', name: 'Revenue by category', chartType: 'column',
        encoding: { category: 'category', values: [{ column: 'revenue', aggregation: 'sum' }] } },
    ],
    texts: [],
  }],
};

/** The edit the stubbed dispatch returns: one KPI tile for average discount. */
const DELTA = {
  ops: [{ op: 'addMetric', page: 1, dataset: 'Retail orders', column: 'discount',
    aggregation: 'avg', label: 'Average discount' }],
};

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO,
    timeout: 120_000,
  });
  let win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');
  const errors: string[] = [];
  const wire = (w: any): void => {
    w.on('pageerror', (e: any) => errors.push('pageerror: ' + e.message));
    w.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  };
  wire(win);

  const killSplash = (): Promise<void> => win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});

  // ── Readiness + the three stubs, installed in MAIN ─────────────────────────
  // A fake key through the real setters: executionReady() then returns true for
  // exactly the reason it would in production, rather than being monkey-patched.
  const ready = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const config = req('./src/app/config.js');
    const execConfig = req('./src/app/execConfig.js');
    const analyze = req('./src/ai/analyze.js');
    const electron = req('electron');
    const g = globalThis as any;

    g.__smoke = { copilot: [] as string[], draft: 0, dispatch: 0, net: 0 };
    g.__next = { text: 'ok', action: { kind: 'none', intent: '' } };
    g.__plan = null;
    g.__delta = null;

    // Nothing may reach the network. A counter AND a throw: a silent count would
    // let a real call succeed and only fail the assertion at the very end.
    const realRequest = electron.net.request;
    electron.net.request = (...a: unknown[]) => {
      g.__smoke.net += 1;
      void realRequest; void a;
      throw new Error('smoke: a model call escaped the stubs and tried the network');
    };

    analyze.askCopilot = async (
      _prior: unknown, _facts: unknown, q: string, onDelta?: (d: string) => void,
    ) => {
      g.__smoke.copilot.push(q);
      const next = g.__next;
      if (onDelta) onDelta(next.text); // one delta: streaming itself is not this file's subject
      return { ok: true, text: next.text, suggestedAction: next.action };
    };
    analyze.draftDashboard = async () => {
      g.__smoke.draft += 1;
      return { ok: true, structure: g.__plan };
    };
    analyze.dispatch = async () => {
      g.__smoke.dispatch += 1;
      return { rawText: JSON.stringify(g.__delta), error: null };
    };

    execConfig.setByokProvider('anthropic', { apiKey: 'sk-smoke-fake' });
    execConfig.setByokVerified('anthropic', true);
    config.save({ executionMode: 'byok', byok: { activeProvider: 'anthropic' } });
    return { ready: execConfig.executionReady(), mode: config.get().executionMode };
  });
  ok('a fake BYOK key makes executionReady() true, with no network',
    ready.ready === true && ready.mode === 'byok', JSON.stringify(ready));

  // Reload so the renderer picks up the new readiness.
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3500);
  await killSplash();

  // The sample seeds itself on first launch; the loop needs its dataset.
  const seeded = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const all = await projects.listProjects();
    for (const p of all) {
      const ds = await datasets.listDatasets(p.id);
      if (ds.some((d: any) => /retail/i.test(String(d.name)))) {
        return { projectId: p.id, projectName: p.name, datasets: ds.map((d: any) => d.name) };
      }
    }
    return { projectId: '', projectName: '', datasets: [] };
  });
  ok('the bundled sample project is present to build against',
    Boolean(seeded.projectId), JSON.stringify(seeded));
  if (!seeded.projectId) { await app.close(); return; }

  await win.evaluate(async (id: string) => { await (window as any).adoptProject(id); }, seeded.projectId);
  await win.waitForTimeout(1200);

  // ── 1. A plain conversation renders PROSE, never the action line ──────────
  await win.evaluate(() => {
    const b = document.getElementById('side-ai-btn') as HTMLElement | null;
    if (b) b.click();
  });
  await win.waitForTimeout(900);
  const composer = await win.evaluate(() => {
    const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
    const send = document.getElementById('dk-send') as HTMLButtonElement | null;
    const pill = document.getElementById('dk-ai-toggle') as HTMLElement | null;
    return {
      open: !!(document.getElementById('dk-panel') as HTMLElement | null)?.offsetParent,
      inputDisabled: !!input && input.disabled,
      sendExists: !!send,
      pill: (pill?.textContent || '').trim(),
    };
  });
  ok('the dock opens with a usable composer', composer.open && !composer.inputDisabled,
    JSON.stringify(composer));
  ok('…and the header pill no longer says "No model"',
    !/no model/i.test(composer.pill), composer.pill);

  const ask = async (text: string): Promise<void> => {
    await win.evaluate((t: string) => {
      const input = document.getElementById('dk-input') as HTMLTextAreaElement;
      input.value = t;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }, text);
    await win.keyboard.press('Enter');
  };
  const setNext = (next: unknown): Promise<void> => app.evaluate(async (_app: any, n: any) => {
    const g = globalThis as any;
    g.__next = n.next;
    if (n.plan !== undefined) g.__plan = n.plan;
    if (n.delta !== undefined) g.__delta = n.delta;
  }, next as any);

  await setNext({ next: { text: 'Hello — ask me about your data.', action: { kind: 'none', intent: '' } } });
  await ask('hi');
  await win.waitForTimeout(2500);
  const plain = await win.evaluate(() => {
    const bubbles = [...document.querySelectorAll('#dk-messages .xp-msg-assistant .xp-bubble')];
    const last = bubbles[bubbles.length - 1];
    return { count: bubbles.length, text: (last?.textContent || '').trim() };
  });
  ok('a plain question renders an answer bubble', plain.count >= 1, JSON.stringify(plain));
  // The #128 regression: the machine-read action line leaking into the answer.
  ok('…carrying the prose only, with no action JSON in it',
    plain.text === 'Hello — ask me about your data.'
      && !/@@ACTION|"kind"|\{/.test(plain.text), JSON.stringify(plain));

  // ── 2. A dashboard request → proposal → Build → a real dashboard ──────────
  await setNext({
    next: { text: 'Here is a dashboard of revenue by region and category.',
      action: { kind: 'dashboard', intent: 'revenue by region and category with a units KPI' } },
    plan: PLAN,
  });
  await ask('build me a dashboard of revenue by region and month with a units KPI');
  await win.waitForSelector('#dk-messages .dk-proposal', { timeout: 30_000 });
  const proposal = await win.evaluate(() => {
    const card = document.querySelector('#dk-messages .dk-proposal') as HTMLElement;
    const tiles = card.querySelectorAll('.an-draft-visual').length;
    const btn = [...card.querySelectorAll('button')]
      .find((b) => /build|create/i.test(b.textContent || ''));
    return { text: (card.textContent || ''), tiles, button: (btn?.textContent || '').trim() };
  });
  ok('a dashboard proposal card renders from a plain conversation',
    proposal.tiles >= 2, JSON.stringify({ tiles: proposal.tiles }));
  ok('…previewing the planned charts and naming the KPI',
    /Revenue by region/i.test(proposal.text) && /Units sold/i.test(proposal.text),
    proposal.text.slice(0, 200));
  ok('…and offering a Build action', /build/i.test(proposal.button), proposal.button);

  await win.evaluate(() => {
    const card = document.querySelector('#dk-messages .dk-proposal') as HTMLElement;
    const btn = [...card.querySelectorAll('button')]
      .find((b) => /build|create/i.test(b.textContent || '')) as HTMLElement;
    btn.click();
  });
  await win.waitForTimeout(7000);

  const built = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#dash-grid .dash-card')];
    return {
      section: (document.querySelector('.hub-body') as HTMLElement)?.dataset.section || '',
      editorOpen: !!(document.getElementById('dash-editor') as HTMLElement | null)?.offsetParent,
      kinds: cards.map((c) => (c.className.match(/dash-card--(\w+)/) || [])[1]),
      canvases: cards.filter((c) => c.querySelector('canvas')).length,
      metrics: cards.filter((c) => c.className.includes('--metric'))
        .map((c) => ((c.querySelector('.dash-metric-value') || {}) as any).textContent || ''),
    };
  });
  ok('Build navigates to the open dashboard', built.editorOpen && built.section === 'analyses',
    JSON.stringify({ section: built.section, open: built.editorOpen }));
  ok('…with at least two chart tiles and one KPI tile',
    built.kinds.filter((k) => k === 'visual').length >= 2
      && built.kinds.filter((k) => k === 'metric').length >= 1, JSON.stringify(built.kinds));
  ok('…every chart drawn, not an empty box', built.canvases >= 2, String(built.canvases));
  ok('…and the KPI showing a real figure rather than a dash',
    built.metrics.length >= 1 && built.metrics.every((m: string) => /\d/.test(m)),
    JSON.stringify(built.metrics));
  await win.screenshot({ path: path.join(shotDir, 'assistant-2-built.png') });

  const onDisk = await app.evaluate(async (_app: any, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const list = await analysis.listAnalyses(pid);
    const rec = await analysis.getAnalysis(pid, list[0].id);
    return { id: rec.id, count: list.length, cards: rec.sheets[0].cards.map((c: any) => c.type) };
  }, seeded.projectId);
  ok('the dashboard is a real record on disk, not just DOM',
    onDisk.cards.filter((t: string) => t === 'visual').length >= 2
      && onDisk.cards.filter((t: string) => t === 'metric').length >= 1,
    JSON.stringify(onDisk.cards));

  // ── 3. An edit against the OPEN dashboard ────────────────────────────────
  await setNext({
    next: { text: 'Adding a KPI for average discount.',
      action: { kind: 'edit', intent: 'add a KPI for average discount' } },
    delta: DELTA,
  });
  await ask('add a KPI for average discount');
  await win.waitForTimeout(6000);
  const editCard = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#dk-messages .dk-proposal')];
    const card = cards[cards.length - 1] as HTMLElement | undefined;
    if (!card) return { found: false, text: '', button: '' };
    const btn = [...card.querySelectorAll('button')].find((b) => /apply/i.test(b.textContent || ''));
    return { found: true, text: card.textContent || '', button: (btn?.textContent || '').trim() };
  });
  ok('an edit proposal card renders for the open dashboard', editCard.found, JSON.stringify(editCard));
  ok('…describing the KPI it would add', /average discount/i.test(editCard.text),
    editCard.text.slice(0, 200));
  ok('…and offering Apply', /apply/i.test(editCard.button), editCard.button);

  await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#dk-messages .dk-proposal')];
    const card = cards[cards.length - 1] as HTMLElement;
    const btn = [...card.querySelectorAll('button')]
      .find((b) => /apply/i.test(b.textContent || '')) as HTMLElement;
    btn.click();
  });
  await win.waitForTimeout(5000);
  const afterEdit = await app.evaluate(async (_app: any, ids: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const rec = await analysis.getAnalysis(ids.pid, ids.aid);
    return {
      metrics: rec.sheets[0].cards.filter((c: any) => c.type === 'metric')
        .map((c: any) => (c.metric && c.metric.label) || ''),
    };
  }, { pid: seeded.projectId, aid: onDisk.id });
  ok('applying the edit adds the KPI tile to the record on disk',
    afterEdit.metrics.some((l: string) => /average discount/i.test(l)),
    JSON.stringify(afterEdit.metrics));
  const domMetrics = await win.evaluate(() =>
    [...document.querySelectorAll('#dash-grid .dash-card--metric')].length);
  ok('…and the open dashboard shows it', domMetrics >= 2, String(domMetrics));
  await win.screenshot({ path: path.join(shotDir, 'assistant-3-edited.png') });

  // ── 4. A style preset ────────────────────────────────────────────────────
  await setNext({
    next: { text: 'Switching to the dark preset.',
      action: { kind: 'style', intent: 'make it dark', preset: 'dark' } },
  });
  await ask('make it the dark preset');
  await win.waitForTimeout(4000);
  await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#dk-messages .dk-proposal')];
    const card = cards[cards.length - 1] as HTMLElement | undefined;
    const btn = card && [...card.querySelectorAll('button')]
      .find((b) => /apply/i.test(b.textContent || '')) as HTMLElement | undefined;
    if (btn) btn.click();
  });
  await win.waitForTimeout(4000);
  const styled = await app.evaluate(async (_app: any, ids: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const rec = await analysis.getAnalysis(ids.pid, ids.aid);
    return rec.style;
  }, { pid: seeded.projectId, aid: onDisk.id });
  ok('the style action changes the dashboard style on disk',
    styled && styled.theme === 'dark', JSON.stringify(styled));

  // ── 5. It all survives a reload ──────────────────────────────────────────
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3500);
  await killSplash();
  await win.evaluate(async (ids: any) => {
    await (window as any).adoptProject(ids.pid);
    (window as any).selectSection('analyses');
    await (window as any).openAnalysis(ids.aid);
  }, { pid: seeded.projectId, aid: onDisk.id });
  await win.waitForTimeout(4000);
  const reopened = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#dash-grid .dash-card')];
    return {
      total: cards.length,
      metrics: cards.filter((c) => c.className.includes('--metric')).length,
      canvases: cards.filter((c) => c.querySelector('canvas')).length,
    };
  });
  ok('after a reload the dashboard reopens with its tiles',
    reopened.total >= 4 && reopened.metrics >= 2 && reopened.canvases >= 2,
    JSON.stringify(reopened));
  await win.screenshot({ path: path.join(shotDir, 'assistant-5-reloaded.png') });

  await win.evaluate(() => {
    const b = document.getElementById('side-ai-btn') as HTMLElement | null;
    if (b) b.click();
  });
  await win.waitForTimeout(2500);
  const history = await win.evaluate(() =>
    document.querySelectorAll('#dk-messages .xp-msg-user').length);
  ok('…and the conversation still holds all four turns', history >= 4, String(history));

  const counts = await app.evaluate(() => (globalThis as any).__smoke);
  ok('every model call went through a stub, none to the network',
    counts.net === 0 && counts.copilot.length >= 4 && counts.draft >= 1 && counts.dispatch >= 1,
    JSON.stringify(counts));
  ok('no renderer console errors across the whole loop', errors.length === 0,
    errors.slice(0, 3).join(' | '));

  await app.close();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
}

main()
  .then(() => {
    if (failureCount()) {
      console.error('\n' + failureCount() + ' assistant-loop smoke check(s) FAILED');
      process.exit(1);
    }
    console.log('\nAll assistant-loop smoke checks passed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
