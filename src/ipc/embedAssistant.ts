// The embedded Assistant's setup handlers (docs/embedded-assistant/00-design.md; contracts in src/api/embedAssistant.ts). An org
// admin marks an agent embeddable on datasets, each with the text column every token must lock; the marking pins the hash of the prepare
// steps that write that column (data/rowAccess.embedMarkCheck), and every ask checks it again. Nothing here reads a row.

import { ipcMain } from './bus';
import { ctx, runInContext } from '../server/context';
import * as datasets from '../data/datasets';
import * as projects from '../app/projects';
import { embedMarkCheck } from '../data/rowAccess';
import { listAgents, readAgent } from '../ai/agents';
import { canStore, readSettings } from '../server/embed/settings';
import { atLeast } from '../server/authz/folders';
import { levelOfItem } from '../server/authz/folderGate';
import {
  askCounts, DEFAULT_DAILY_CAP, DEFAULT_PER_MINUTE_CAP, getCaps, listEmbedAgents, MAX_DAILY_CAP, MAX_EMBED_DATASETS, MAX_PER_MINUTE_CAP, removeEmbedAgent, setCaps, setEmbedAgent, setEmbedEnabled, type EmbedDataset,
} from '../server/embed/assistants';
import {
  embedAdminCaps, embedAdminColumn, embedAdminFolder, embedAdminNeedsDataset, embedAdminNeedsStore, embedAdminNoAgent, embedAdminNoDataset, embedAdminPipeline, embedAdminRules, embedAdminTooMany,
} from '../server/embedAskMessages';

const org = (): string => ctx().org.id;
type Refusal = { ok: false; error: string };

/**
 * Is the dataset in Everyone in the project, so a caller with no team opens it? The embed asker has no team, and the ask's folder
 * gate refuses a dataset in a team folder: marking one would show "Locked" and fail every question. Asked as that caller would be.
 */
async function openToEveryone(projectId: string, datasetId: string): Promise<boolean> {
  const who = { user: { email: 'embed:check', role: 'viewer' as const }, org: { id: org() }, embed: { agentId: '00000000-0000-4000-8000-000000000000', projectId, customer: '', datasets: {} } };
  return runInContext(who, ctx().requestId, async () => atLeast(await levelOfItem(projectId, 'dataset', datasetId), 'view'));
}

/** One marked dataset as the screen shows it: whether its lock still holds, from the record as it is now. */
async function stateOf(projectId: string, d: EmbedDataset): Promise<{ id: string; name: string; column: string; state: 'ok' | 'gone' | 'folder' | 'column' | 'rules' | 'pipeline' | 'changed' }> {
  const meta = await datasets.getDatasetMeta(projectId, d.id);
  if (!meta) return { id: d.id, name: '', column: d.column, state: 'gone' };
  if (!(await openToEveryone(projectId, d.id))) return { id: d.id, name: meta.name, column: d.column, state: 'folder' };
  const c = await embedMarkCheck(projectId, d.id, d.column);
  const state = c.ok ? (c.writers === d.writers ? 'ok' : 'changed') : c.reason === 'column' ? 'column' : c.reason === 'pipeline' ? 'pipeline' : 'rules';
  return { id: d.id, name: meta.name, column: d.column, state };
}

export function register(): void {
  ipcMain.handle('embedAssistant:settings', async () => {
    const stored = canStore();
    const rows = stored ? await listEmbedAgents(org()) : [];
    const agents = [];
    for (const r of rows) {
      const project = await projects.getProject(r.projectId);
      const agent = await readAgent(r.projectId, r.agentId);
      agents.push({
        agentId: r.agentId, projectId: r.projectId, projectName: project?.name ?? '', agentName: agent?.rec.name ?? '', gone: !project || !agent, enabled: r.enabled,
        datasets: await Promise.all(r.datasets.map((d) => stateOf(r.projectId, d))),
      });
    }
    return {
      canStore: stored, org: org(), embeddingOn: (await readSettings(org())).enabled, agents,
      caps: stored ? await getCaps(org()) : { daily: DEFAULT_DAILY_CAP, perMinute: DEFAULT_PER_MINUTE_CAP },
      limits: { maxDaily: MAX_DAILY_CAP, maxPerMinute: MAX_PER_MINUTE_CAP, maxDatasets: MAX_EMBED_DATASETS, defaultDaily: DEFAULT_DAILY_CAP, defaultPerMinute: DEFAULT_PER_MINUTE_CAP },
      counts: stored ? await askCounts(org()) : { today: 0, limited: 0 },
    };
  });

  ipcMain.handle('embedAssistant:options', async (_e, { projectId }: { projectId: string }) => {
    if (!(await projects.getProject(projectId))) return { ok: false as const, error: embedAdminNoAgent() };
    const metas = await Promise.all((await datasets.listDatasets(projectId)).slice(0, 200).map((d) => datasets.getDatasetMeta(projectId, d.id)));
    return {
      ok: true as const,
      agents: (await listAgents(projectId)).map((a) => ({ id: a.id, name: a.name })),
      datasets: metas.flatMap((m) => (m ? [{ id: m.id, name: m.name, textColumns: m.columns.filter((c) => c.type === 'text').map((c) => c.name) }] : [])),
    };
  });

  ipcMain.handle('embedAssistant:save', async (_e, input: { projectId: string; agentId: string; enabled: boolean; datasets: { id: string; column: string }[] }): Promise<{ ok: true } | Refusal> => {
    if (!canStore()) return { ok: false, error: embedAdminNeedsStore() };
    if (!(await projects.getProject(input.projectId)) || !(await readAgent(input.projectId, input.agentId))) return { ok: false, error: embedAdminNoAgent() };
    if (input.enabled && !input.datasets.length) return { ok: false, error: embedAdminNeedsDataset() };
    if (input.datasets.length > MAX_EMBED_DATASETS) return { ok: false, error: embedAdminTooMany(MAX_EMBED_DATASETS) };
    const marked: EmbedDataset[] = [];
    for (const d of input.datasets) {
      const meta = await datasets.getDatasetMeta(input.projectId, d.id);
      if (!meta) return { ok: false, error: embedAdminNoDataset() };
      if (!meta.columns.some((c) => c.name === d.column && c.type === 'text')) return { ok: false, error: embedAdminColumn(meta.name) };
      if (!(await openToEveryone(input.projectId, d.id))) return { ok: false, error: embedAdminFolder(meta.name) };
      const c = await embedMarkCheck(input.projectId, d.id, d.column);
      if (!c.ok) return { ok: false, error: c.reason === 'column' ? embedAdminColumn(meta.name) : c.reason === 'pipeline' ? embedAdminPipeline(meta.name) : embedAdminRules(meta.name) };
      if (!marked.some((m) => m.id === d.id.toLowerCase())) marked.push({ id: d.id.toLowerCase(), column: d.column, writers: c.writers });
    }
    await setEmbedAgent(org(), ctx().user.email, { agentId: input.agentId, projectId: input.projectId, datasets: marked, enabled: input.enabled });
    return { ok: true };
  });

  // On or off, nothing else: the saved datasets and their pins stay, so switching off and on never re-approves a changed pipeline.
  ipcMain.handle('embedAssistant:setEnabled', async (_e, { agentId, enabled }: { agentId: string; enabled: boolean }): Promise<{ ok: true } | Refusal> => {
    if (!canStore()) return { ok: false, error: embedAdminNeedsStore() };
    return (await setEmbedEnabled(org(), agentId, enabled)) ? { ok: true } : { ok: false, error: embedAdminNoAgent() };
  });

  ipcMain.handle('embedAssistant:remove', async (_e, { agentId }: { agentId: string }): Promise<{ ok: true } | Refusal> => {
    if (!canStore()) return { ok: false, error: embedAdminNeedsStore() };
    return (await removeEmbedAgent(org(), agentId)) ? { ok: true } : { ok: false, error: embedAdminNoAgent() };
  });

  ipcMain.handle('embedAssistant:setLimits', async (_e, input: { daily: number; perMinute: number }): Promise<{ ok: true } | Refusal> => {
    if (!canStore()) return { ok: false, error: embedAdminNeedsStore() };
    if (!Number.isInteger(input.daily) || !Number.isInteger(input.perMinute) || input.daily < 1 || input.daily > MAX_DAILY_CAP || input.perMinute < 1 || input.perMinute > MAX_PER_MINUTE_CAP) return { ok: false, error: embedAdminCaps() };
    await setCaps(org(), { daily: input.daily, perMinute: input.perMinute });
    return { ok: true };
  });
}
