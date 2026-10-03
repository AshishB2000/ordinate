// The browser half of the T0.4 file flows (src/server/files.ts), which replace
// the desktop's open and save dialogs: a file the user picks is uploaded
// first and a channel takes its `fileToken`; a file the server made comes
// back from a channel as a `downloadToken` the browser fetches. Tokens are
// single-use and bound to this signed-in user.

import { CLIENT_ID, RpcError } from './client';

export interface Uploaded {
  fileToken: string;
  name: string;
  size: number;
}

/** POST /api/files: one file, streamed to the server's temp; 413 over the org's upload cap. */
export async function uploadFile(file: File): Promise<Uploaded> {
  const form = new FormData();
  form.append('file', file, file.name);
  let res: Response;
  try {
    res = await fetch('/api/files', { method: 'POST', body: form, credentials: 'same-origin', headers: { 'X-Ordinate-Client': CLIENT_ID } });
  } catch {
    throw new RpcError(0, 'network', 'Could not reach the Ordinate server.');
  }
  const body = (await res.json().catch(() => ({}))) as Partial<Uploaded> & { error?: string; maxMb?: number };
  if (res.status === 413) {
    throw new RpcError(413, 'too_large', body.maxMb ? `That file is over the ${body.maxMb} MB upload limit.` : 'That file is over the upload limit.');
  }
  if (!res.ok || typeof body.fileToken !== 'string') throw new RpcError(res.status, 'upload', body.error ?? `Upload failed (${res.status}).`);
  return { fileToken: body.fileToken, name: body.name ?? file.name, size: body.size ?? file.size };
}

/** Starts the browser's own download of a server-made file (Content-Disposition: attachment, so the page stays). */
export function startDownload(downloadToken: string): void {
  const a = document.createElement('a');
  a.href = `/api/files/${encodeURIComponent(downloadToken)}`;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}
