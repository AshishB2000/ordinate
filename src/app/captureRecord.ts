// Where a capture BELONGS: the project it lands in, and the dock conversation
// its analysis seeds. MAIN PROCESS.
//
// Split out of main.ts under the 800-line cap (.claude/rules/file-size.md).
// main.ts is the app's wiring — windows, the capture loop, IPC registration —
// and these are the three questions the capture loop has to answer about the
// RECORD it is about to write: what goes in it, which project owns it, and
// which conversation narrates it. The last two are best-effort: a capture must
// never be lost because the project could not be resolved or the conversation
// could not be created.

import * as projects from './projects';
import * as copilot from '../ai/copilot';

// The result we persist per turn: the FULL analysis result minus the raw provider
// thread (_messages is stored separately in thread.messages and never goes to the
// renderer). Persisting everything — metrics, headlineProse, extractedTable, geo,
// … — is what lets a reloaded capture render identically to the fresh one (the old
// title/analysis/data/visualizations/followups allowlist dropped the rest).
// ponytail: analysis results are big model-shaped JSON envelopes — typing them
// fully isn't worth it here.
export function persistableResult(result: any): any {
  const { _messages, ...rest } = result;
  return rest;
}

// The project a capture lands in. A capture is a project record now, and the
// renderer must not be asked for the id at capture time: the ⌘⌥S hotkey fires
// with the hub unfocused (often closed), so there is no renderer to ask. Main
// tracks the last project the user opened or created instead, and falls back to
// the newest project on disk — the same project a fresh quick-capture would
// have created anyway.
let activeProjectId: string | null = null;

/** Called from ipc/projects when the user opens or creates one. */
export function setActiveProject(id: string): void {
  activeProjectId = id;
}

export async function captureProjectId(): Promise<string | null> {
  if (activeProjectId) return activeProjectId;
  try {
    const list = await projects.listProjects();
    return (Array.isArray(list) && list[0] && list[0].id) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Open the capture's conversation in the dock, seeded with the analysis.
 *
 * The capture surface used to own a thread widget and a follow-up box of its
 * own. It doesn't any more: the narration is simply the FIRST assistant turn of
 * an ordinary dock conversation, and a follow-up about a capture is an ordinary
 * dock ask. Returns the thread id (stored on the capture so its "Ask" button
 * opens THIS conversation), or null when there is nothing to seed — no project,
 * a failed analysis, or an empty narration.
 *
 * Best-effort by design: a conversation that could not be seeded must never
 * lose the capture, so every failure resolves to null and the capture is saved
 * regardless.
 * ponytail: the analysis result is a model-shaped envelope — any.
 */
export async function seedCaptureConversation(projectId: string | null, result: any): Promise<string | null> {
  const text = result && typeof result.analysis === 'string' ? result.analysis.trim() : '';
  if (!projectId || !result.ok || !text) return null;
  try {
    const thread = await copilot.createThread(projectId);
    if (!thread) return null;
    await copilot.appendTurn(projectId, {
      role: 'assistant',
      text,
      provenance: { kind: 'capture', name: result.title || 'Capture', note: 'stats app-computed' },
    }, thread.id);
    return thread.id;
  } catch (err: any) {
    console.error('[capture] Could not seed the capture conversation:', err && err.message);
    return null;
  }
}
