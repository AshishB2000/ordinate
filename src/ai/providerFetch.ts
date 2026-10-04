// The one HTTP door to a model provider (analyze.ts, analyzeStream.ts,
// models.ts). The desktop uses Electron's `net.fetch` — the system proxy and
// certificate store, as before. A server has no Electron, and a gateway's base
// URL there is typed by an org admin, so the call goes through the SSRF guard's
// safeFetch (src/connectors/ssrf.ts): host checked and pinned, every redirect
// re-checked.

import { guardOn, safeFetch } from '../connectors/ssrf';

export function providerFetch(url: string, init: RequestInit): Promise<Response> {
  if (guardOn()) return safeFetch(url, init);
  return (require('electron') as typeof import('electron')).net.fetch(url, init);
}
