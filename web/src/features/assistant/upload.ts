// One file up to the server (T0.4): POST /api/files, multipart, one part. The
// reply's single-use `fileToken` is what a handler accepts instead of a path.
// ponytail: the dock's import step is its only caller here; T2.4's importer
// moves this to web/src/api when it ports the composer.

import { send } from '../../api/client';

export async function uploadFile(file: File): Promise<{ fileToken: string; name: string; size: number }> {
  const body = new FormData();
  body.append('file', file, file.name);
  let res: Response;
  try {
    res = await send('/api/files', { method: 'POST', body }); // with the CSRF header (T6.2)
  } catch {
    throw new Error('Could not reach the Ordinate server.');
  }
  if (res.status === 413) throw new Error(`${file.name} is larger than this server accepts.`);
  if (!res.ok) throw new Error(`The upload failed (${res.status}).`);
  return (await res.json()) as { fileToken: string; name: string; size: number };
}
