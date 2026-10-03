// The download half of the T0.4 file flows (src/server/files.ts), which
// replace the desktop's save dialogs: a file the server made comes back from
// a channel as a `downloadToken` the browser fetches (single use, bound to
// this signed-in user). The upload half is `upload()` in ./client.ts.

/** Starts the browser's own download of a server-made file (Content-Disposition: attachment, so the page stays). */
export function startDownload(downloadToken: string): void {
  const a = document.createElement('a');
  a.href = `/api/files/${encodeURIComponent(downloadToken)}`;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}
