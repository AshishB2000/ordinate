// The model stub the workflow smoke's sections share — smoke-assistant's
// seam, as a QUEUE.
//
// smoke-assistant replaces `analyze.askCopilot` with one canned `__next`
// reply. An answer turn calls the model TWICE (the ask, then the narration of
// the chart the app built), so here each call takes the next queued reply,
// and an empty queue falls back to a plain, figure-free sentence. Readiness is
// real config written through the same setters Settings uses, and nothing may
// reach the network: electron.net.request throws and counts.
//
// Not a smoke file itself (no `smoke-` prefix, not in run-smokes): a helper
// imported by scripts/smoke-workflow.ts and its sections.

import type { Smoke } from './smokeFixture';

export interface StubReply {
  text: string;
  action?: { kind: string; intent: string; spec?: unknown; preset?: string };
}

/** Install the queue-backed stub in MAIN and make executionReady() true. */
export async function installModelStub(s: Smoke): Promise<{ ready: boolean }> {
  return s.app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const config = req('./src/app/config.js');
    const execConfig = req('./src/app/execConfig.js');
    const analyze = req('./src/ai/analyze.js');
    const electron = req('electron');
    const g = globalThis as any;
    g.__wf = { queue: [] as any[], asked: [] as string[], net: 0, plan: null as any };
    electron.net.request = () => {
      g.__wf.net += 1;
      throw new Error('smoke: a model call escaped the stub and tried the network');
    };
    analyze.askCopilot = async (_prior: unknown, facts: string, q: string, onDelta?: (d: string) => void) => {
      g.__wf.asked.push(q + '\n' + facts);
      const next = g.__wf.queue.shift() || { text: 'Here is what the data shows.', action: { kind: 'none', intent: '' } };
      if (onDelta) onDelta(next.text);
      return { ok: true, text: next.text, suggestedAction: next.action || { kind: 'none', intent: '' } };
    };
    analyze.draftDashboard = async () => ({ ok: true, structure: g.__wf.plan });
    execConfig.setByokProvider('anthropic', { apiKey: 'sk-smoke-fake' });
    execConfig.setByokVerified('anthropic', true);
    config.save({ executionMode: 'byok', byok: { activeProvider: 'anthropic' } });
    return { ready: execConfig.executionReady() };
  });
}

/** Queue the model's next replies, in call order. */
export async function queueReplies(s: Smoke, replies: StubReply[]): Promise<void> {
  await s.app.evaluate(async (_app: unknown, r: StubReply[]) => { (globalThis as any).__wf.queue.push(...r); }, replies);
}

/** How many model calls tried the network (must stay 0), and every question the stub was asked. */
export async function stubState(s: Smoke): Promise<{ net: number; asked: string[]; queued: number }> {
  return s.app.evaluate(async () => {
    const w = (globalThis as any).__wf;
    return { net: w.net, asked: w.asked.slice(), queued: w.queue.length };
  });
}

/** The sample project's ids, found through the real stores. */
export async function sampleIds(s: Smoke): Promise<{ projectId: string; datasetId: string; dashboardId: string }> {
  return s.app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const analysis = req('./src/analysis/analysis.js');
    for (const p of await projects.listProjects()) {
      const ds = (await datasets.listDatasets(p.id)).find((d: any) => d.name === 'Retail orders');
      if (!ds) continue;
      const an = (await analysis.listAnalyses(p.id)).find((a: any) => a.name === 'Retail overview');
      return { projectId: p.id, datasetId: ds.id, dashboardId: an ? an.id : '' };
    }
    return { projectId: '', datasetId: '', dashboardId: '' };
  });
}
