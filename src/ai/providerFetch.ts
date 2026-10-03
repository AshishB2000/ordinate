// The one HTTP door to a model provider (analyze.ts, analyzeStream.ts,
// models.ts). The desktop uses Electron's `net.fetch` — the system proxy and
// certificate store, as before. A server has no Electron: Node's own fetch.
//
// ponytail: on the server the base URL is an org admin's setting (byok:saveProvider
// is admin-only), so it is not run through an SSRF guard yet — T6.1's safeFetch
// takes over this call when it lands.

import { serverDataDir } from '../server/context';

export function providerFetch(url: string, init: RequestInit): Promise<Response> {
  if (serverDataDir() !== null) return fetch(url, init);
  return (require('electron') as typeof import('electron')).net.fetch(url, init);
}
