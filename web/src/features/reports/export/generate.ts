// Generate a file: the server resolves the pages (`report:build` /
// `story:export`, audited), the browser asks the Share policy's question when
// it has one, draws the charts, writes the bytes with the format's library and
// hands the file to the browser's own download. Nothing reaches the server's
// disk; `reports:generated` only stamps "last generated" on the record.

import { rpc } from '../../../api/client';
import { failure, type PagesReply, type ReportFormat, type ShareNote } from '../api';
import { reportFilename, type PageSetup, type ReadyPage } from './blocks';
import { materialize } from './materialize';

export interface GenerateHooks {
  /** The policy INCLUDES sensitive columns: the reader must say yes before the file is made. */
  confirmInclude(note: ShareNote): Promise<boolean>;
  /** A masked / dropped note, said once; and progress words. */
  say(message: string): void;
}

export type GenerateResult = { ok: true; filename: string } | { ok: false; error?: string; cancelled?: boolean };

/** Bytes for one format, each library loaded on first use. */
export async function writeFile(pages: ReadyPage[], setup: PageSetup, date: string): Promise<Blob> {
  if (setup.format === 'pptx') return (await import('./pptx')).pptxBlob(pages, setup, date);
  if (setup.format === 'docx') return (await import('./docx')).docxBlob(pages, setup, date);
  return (await import('./pdf')).pdfBlob(pages, setup, date);
}

/** The browser's own download of a file made here (no server round trip, no token: the bytes never left the tab). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function finish(reply: PagesReply, setup: PageSetup, projectId: string, hooks: GenerateHooks): Promise<GenerateResult> {
  if (!reply.ok) return { ok: false, error: reply.error };
  if (!reply.pages.length) return { ok: false, error: 'Every page is excluded — nothing to build.' };
  if (reply.share) {
    if (reply.share.action === 'include') {
      if (!(await hooks.confirmInclude(reply.share))) return { ok: false, cancelled: true };
    } else hooks.say(reply.share.line);
  }
  const ready = await materialize(reply.pages, setup, projectId);
  const blob = await writeFile(ready, setup, (reply as { date?: string }).date || new Date().toLocaleDateString());
  const filename = reportFilename(setup.name, setup.format);
  saveBlob(blob, filename);
  return { ok: true, filename };
}

/** A saved report → its file. The caller saves unsaved settings first, so the file is reproducible. */
export async function generateReport(projectId: string, id: string, setup: PageSetup, hooks: GenerateHooks): Promise<GenerateResult> {
  try {
    const reply = (await rpc('report:build', { projectId, id })) as PagesReply;
    const out = await finish(reply, setup, projectId, hooks);
    // Stamped for an editor; a viewer's generate is not a write, so its 403 is expected and ignored.
    if (out.ok) await rpc('reports:generated', { projectId, id }).catch(() => undefined);
    return out;
  } catch (err) {
    return { ok: false, error: failure(err, 'Couldn’t build the report.') };
  }
}

/** A story → one PDF, a page per heading (storyPresent.ts stExportPdf). */
export async function exportStory(projectId: string, id: string, name: string, hooks: GenerateHooks, format: ReportFormat = 'pdf'): Promise<GenerateResult> {
  try {
    const reply = (await rpc('story:export', { projectId, id })) as PagesReply;
    return await finish(reply, { name, format, paper: { size: 'letter', orientation: 'portrait' } }, projectId, hooks);
  } catch (err) {
    return { ok: false, error: failure(err, 'Couldn’t build the PDF.') };
  }
}
