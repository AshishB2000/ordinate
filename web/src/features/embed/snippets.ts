// The code a host app's BACKEND runs to sign an embed token — Node and Python,
// standard library only (docs/embed/00-design.md). Filled in with this
// server's origin, the org id and, from a dashboard's Embed dialog, its ids
// and the locks picked there. embedSnippets.test.ts runs both and checks the
// token they print against an independent HMAC.

export interface SnippetInput {
  /** This Ordinate server, e.g. https://bi.acme.com. */
  server: string;
  org: string;
  pub?: string;
  dash?: string;
  params?: Record<string, (string | number)[]>;
  theme?: 'light' | 'dark';
  hide?: string[];
}

/** The claims the snippet signs, without `exp` (the snippet adds it). */
export function claimsOf(i: SnippetInput): Record<string, unknown> {
  return {
    pub: i.pub ?? '<published link id>',
    ...(i.dash ? { dash: i.dash } : {}),
    ...(i.params && Object.keys(i.params).length ? { params: i.params } : {}),
    ...(i.theme ? { theme: i.theme } : {}),
    ...(i.hide && i.hide.length ? { hide: i.hide } : {}),
  };
}

/** JSON as a person writes it: indented, with a short list of values on one line. */
export function pretty(v: unknown, indent: number): string {
  return JSON.stringify(v, null, indent).replace(/\[\n\s*([^[\]{}]*?)\n\s*\]/g, (_m, inner: string) => `[${inner.split(/,\n\s*/).join(', ')}]`);
}

export function nodeSnippet(i: SnippetInput): string {
  const claims = pretty(claimsOf(i), 2);
  return `// Sign an Ordinate embed link on your server. Node 18+, no packages.
const crypto = require('node:crypto');

const ORDINATE = ${JSON.stringify(i.server)};
const SECRET = process.env.ORDINATE_EMBED_SECRET; // from Admin → Embedding

function embedUrl(claims, minutes = 10) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT', kid: ${JSON.stringify(i.org)} });
  const body = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + minutes * 60 });
  const sig = crypto.createHmac('sha256', SECRET).update(head + '.' + body).digest('base64url');
  return ORDINATE + '/embed/' + head + '.' + body + '.' + sig;
}

// Per page view, for the signed-in user.
// Lock values come from YOUR session, never from the browser.
const src = embedUrl(${claims});
// <iframe src="\${src}" width="100%" height="800"></iframe>
`;
}

export function pythonSnippet(i: SnippetInput): string {
  const claims = pretty(claimsOf(i), 4);
  return `# Sign an Ordinate embed link on your server. Python 3, stdlib only.
import base64, hashlib, hmac, json, os, time

ORDINATE = ${JSON.stringify(i.server)}
SECRET = os.environ["ORDINATE_EMBED_SECRET"]  # from Admin → Embedding

def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

def embed_url(claims: dict, minutes: int = 10) -> str:
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT", "kid": ${JSON.stringify(i.org)}}).encode())
    body = _b64(json.dumps({**claims, "exp": int(time.time()) + minutes * 60}).encode())
    sig = _b64(hmac.new(SECRET.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    return f"{ORDINATE}/embed/{head}.{body}.{sig}"

# Per page view, for the signed-in user.
# Lock values come from YOUR session, never from the browser.
src = embed_url(${claims.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False')})
# <iframe src="{src}" width="100%" height="800"></iframe>
`;
}
