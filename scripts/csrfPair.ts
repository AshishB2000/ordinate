// The CSRF pair server suites send on every non-GET (src/server/csrf.ts): the
// same token as a cookie and as X-CSRF-Token, as the web client does. A dev or
// test server's cookie is `ordinate_csrf`; prod's `__Host-` name needs https.

export const CSRF_TOKEN = 'csrf-test-token-'.padEnd(43, 'x');

/** `h` plus the pair; a cookie already in `h` is kept. */
export function withCsrf(h: Record<string, string> = {}): Record<string, string> {
  const pair = `ordinate_csrf=${CSRF_TOKEN}`;
  return { ...h, 'x-csrf-token': CSRF_TOKEN, cookie: h.cookie ? `${h.cookie}; ${pair}` : pair };
}
