// Alerts IPC — the thin edge in front of src/analysis/alertStore.ts.
//
// Everything here is `ipcMain.handle` (request/response) and every handler turns
// a throw into `{ ok:false, error }`, so the renderer never sees an unhandled
// rejection. No handler computes a number, composes a message or decides whether
// a rule fired: those are alertStore's and alerts.ts's jobs respectively, and
// this file exists so the renderer has doors into them.
//
// The one thing this file DOES own is delivery: `deliver()` is the single place
// that turns fired events into the push each signed-in tab's bell repaints
// from, and it is what both the server's tick and a manual "evaluate now" call.
//
// THE EXPLAIN PATH IS THE ONLY MODEL CALL, and it is asked for (`alerts:explain`):
// the event is already on disk before `explainEvent` is called. It narrates
// figures the app computed — `buildFacts` builds the block, `guardAnswer`
// audits the reply against that ledger — exactly like every other narration in
// this app.

import { ipcMain } from './bus';

import * as store from '../analysis/alertStore';
import * as alerts from '../analysis/alerts';
import type { AlertEvent } from '../analysis/alerts';
import * as copilot from '../ai/copilot';
import * as execConfig from '../app/execConfig';
import { askCopilot } from '../ai/analyze';
import { buildFacts, guardAnswer } from './copilot';
import { serverDataDir } from '../server/context';

// ── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Everything one evaluation produced, delivered once: every tab of the org gets
 * the push its bell repaints from, exactly what the tick job sends — only to
 * members who may read the project (T6.3), since an alert carries its figures.
 * Outside server mode (a plain-Node test) there is no one to tell. Returns how
 * many OS notifications were shown, which the server never does: 0.
 */
export async function deliver(projectId: string, events: AlertEvent[]): Promise<number> {
  if (!Array.isArray(events) || events.length === 0) return 0;
  if (serverDataDir() !== null) {
    (require('../server/jobs/schedules') as typeof import('../server/jobs/schedules')).pushToReaders(projectId, 'alerts:fired', { projectId, events });
  }
  return 0;
}

/**
 * Evaluate, and say what fired. DELIBERATELY DOES NOT DELIVER — the scheduler
 * calls this once per refreshed dataset and delivers the whole tick at the end,
 * which is the only way "one notification per refresh tick" can be true.
 */
export async function evaluateOnly(projectId: string, datasetId?: string): Promise<AlertEvent[]> {
  // The watch toggle is a shortcut into the rule set, so it is reconciled first
  // — otherwise a dataset watched today would not be evaluated until something
  // else happened to open the rules page.
  await store.syncWatchRules(projectId);
  return store.evaluateProject(projectId, datasetId);
}

/**
 * Evaluate on demand and deliver straight away — one dataset's manual Refresh,
 * or the inbox's "check now". There is no tick to batch against here, so the
 * digest option still applies but over this one evaluation.
 */
export async function evaluateAndDeliver(projectId: string, datasetId?: string): Promise<AlertEvent[]> {
  const fired = await evaluateOnly(projectId, datasetId);
  await deliver(projectId, fired);
  return fired;
}

// ── Explain (optional, opt-in, never on the critical path) ───────────────────

/**
 * Seed ONE dock conversation for an event: the app's own sentence as the
 * question, the model's narration as the first assistant turn.
 *
 * The same shape `captureRecord.seedCaptureConversation` uses — a narration is
 * simply the first turn of an ordinary dock conversation, so a follow-up about
 * an alert is an ordinary dock ask. Returns the thread id, or null when there is
 * no model, the dataset is gone, or the call failed. Best-effort throughout: an
 * explanation that could not be written must never disturb the event it is about.
 */
export async function explainEvent(projectId: string, event: AlertEvent): Promise<string | null> {
  if (!execConfig.executionReady()) return null;
  try {
    // The FACTS are the dataset's, app-computed, exactly as a dock ask about
    // that dataset would build them. The event's own figures ride in the
    // question, which is app-composed text — no figure here is a model's.
    const facts = await buildFacts(projectId, { kind: 'dataset', id: event.datasetId });
    const question = `${event.message} Why might that have happened?`;
    const res = await askCopilot([], facts.text, question);
    if (!res.ok || !res.text) return null;
    const thread = await copilot.createThread(projectId);
    if (!thread) return null;
    await copilot.appendTurn(projectId, { role: 'user', text: question }, thread.id);
    await copilot.appendTurn(projectId, {
      role: 'assistant',
      text: guardAnswer(res.text, facts.ledger).text,
      provenance: facts.provenance,
    }, thread.id);
    return thread.id;
  } catch (err: any) {
    console.error('[alerts] Could not explain an alert:', err && err.message);
    return null;
  }
}

// ── Channels ─────────────────────────────────────────────────────────────────

export function register(): void {

  // The inbox and the rules page read the same payload: one file, two surfaces.
  // `unseen` is derived here rather than counted in the renderer so the bell and
  // the list can never disagree about what "unread" means.
  ipcMain.handle('alerts:list', async (_e, { projectId }: any = {}) => {
    try {
      await store.syncWatchRules(projectId);
      const file = await store.load(projectId);
      return {
        ok: true,
        rules: file.rules,
        events: file.events,
        digest: file.digest,
        unseen: file.events.filter((ev) => !ev.seen).length,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not read alerts' };
    }
  });

  ipcMain.handle('alerts:save', async (_e, { projectId, rule }: any = {}) => {
    try {
      const saved = await store.saveRule(projectId, rule);
      if (!saved) return { ok: false, error: 'That rule is not complete.' };
      return { ok: true, rule: saved };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not save the rule' };
    }
  });

  // enabled / quiet hours / snooze — the three things the rules page and the
  // inbox change without reopening the dialog.
  ipcMain.handle('alerts:patch', async (_e, { projectId, ruleId, patch }: any = {}) => {
    try {
      const rule = await store.patchRule(projectId, ruleId, patch);
      if (!rule) return { ok: false, error: 'No such rule.' };
      return { ok: true, rule };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not update the rule' };
    }
  });

  ipcMain.handle('alerts:delete', async (_e, { projectId, ruleId }: any = {}) => {
    try {
      return { ok: await store.deleteRule(projectId, ruleId) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not delete the rule' };
    }
  });

  // "Would fire / would not fire", with the numbers. The whole point of the
  // button is that it runs the REAL metric path, so the figure it reports is the
  // figure a real firing would carry.
  ipcMain.handle('alerts:test', async (_e, { projectId, rule }: any = {}) => {
    try {
      const res = await store.testRule(projectId, rule);
      if (!res.ok) return { ok: false, error: 'That rule is not complete.' };
      return res;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not test the rule' };
    }
  });

  // Evaluate now — the whole project, or one dataset after a manual Refresh.
  ipcMain.handle('alerts:evaluate', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      const id = typeof datasetId === 'string' && datasetId ? datasetId : undefined;
      const fired = await evaluateAndDeliver(projectId, id);
      return { ok: true, fired: fired.length, events: fired };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not evaluate the alerts' };
    }
  });

  ipcMain.handle('alerts:markSeen', async (_e, { projectId, eventId }: any = {}) => {
    try {
      const id = typeof eventId === 'string' && eventId ? eventId : undefined;
      return { ok: await store.markSeen(projectId, id) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not update the inbox' };
    }
  });

  ipcMain.handle('alerts:setDigest', async (_e, { projectId, on }: any = {}) => {
    try {
      return { ok: await store.setDigest(projectId, Boolean(on)) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not change that setting' };
    }
  });

  // The inbox's "Explain" button — the PULL half of the same path `deliver`
  // runs on push. `not_ready` (rather than an error) is the shape every other
  // optional-AI channel in this app returns with no model configured.
  ipcMain.handle('alerts:explain', async (_e, { projectId, event }: any = {}) => {
    try {
      const ev = alerts.sanitizeEvent(event);
      if (!ev) return { ok: false, error: 'No such alert.' };
      if (!execConfig.executionReady()) return { ok: false, reason: 'not_ready' };
      const threadId = await explainEvent(projectId, ev);
      if (!threadId) return { ok: false, error: 'Could not write an explanation.' };
      return { ok: true, threadId };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not explain that alert' };
    }
  });
}
