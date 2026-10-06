// The one HTTP door to a model provider (analyze.ts, analyzeStream.ts,
// models.ts). A gateway's base URL is typed by an org admin, so on the server
// the call goes through the SSRF guard's safeFetch (src/connectors/ssrf.ts):
// host checked and pinned, every redirect re-checked. Outside server mode (a
// plain-Node test) it is the platform fetch.

import { guardOn, safeFetch } from '../connectors/ssrf';

export function providerFetch(url: string, init: RequestInit): Promise<Response> {
  if (guardOn()) return safeFetch(url, init);
  return fetch(url, init);
}
