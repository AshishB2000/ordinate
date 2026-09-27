// The fake `fetch` the SaaS self-checks inject (saasHttp.setFetch), plus the
// recorded responses under scripts/fixtures/saas/. No network, no server: a
// route function answers each request, and every request is recorded so a test
// can assert what was ASKED (page sizes, date filters, where the token went).
//
// Not a suite itself — test-connectorsSaas.ts and test-saasBounds.ts import it.

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

export interface FakeCall {
  url: URL;
  method: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Never answer; reject when the request's signal aborts (a hung server). */
  hang?: boolean;
}

export function fakeFetch(route: (call: FakeCall) => FakeReply): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers || {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    const call: FakeCall = {
      url: new URL(url),
      method: String(init.method || 'GET'),
      headers,
      body: typeof init.body === 'string' ? init.body : '',
    };
    calls.push(call);
    const r = route(call);
    if (r.hang) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    const status = r.status || 200;
    const body = status >= 300 && status < 400 ? null : r.text !== undefined ? r.text : JSON.stringify(r.json ?? null);
    return new Response(body, { status, headers: r.headers });
  };
  return { fetch, calls };
}

const DIR = path.join(__dirname, 'fixtures', 'saas');

/** A recorded JSON response. */
// ponytail: fixtures are API-shaped JSON; each test reads the fields it asserts.
export function fixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
}

/** A recorded text response (the published-CSV one). */
export function fixtureText(name: string): string {
  return fs.readFileSync(path.join(DIR, name), 'utf8');
}
