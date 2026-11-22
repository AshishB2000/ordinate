// The code a host app's BACKEND runs to sign an Assistant token and frame the page (docs/embedded-assistant): Node and Python, standard
// library only, and the iframe. Filled in with this server's origin, the org id and, once an agent is marked, its id and the columns it locks.

export interface AssistantSnippetInput {
  /** This Ordinate server, e.g. https://bi.acme.com. */
  server: string;
  org: string;
  agentId?: string;
  /** The columns every link must lock (the marked datasets'). */
  columns?: string[];
}

const claims = (i: AssistantSnippetInput): string => `{ agent: ${JSON.stringify(i.agentId ?? '<agent id>')}, sub: String(user.id), params: { ${(i.columns?.length ? i.columns : ['customer_id']).map((c) => `${JSON.stringify(c)}: [user.customerId]`).join(', ')} } }`;

export function nodeAssistantSnippet(i: AssistantSnippetInput): string {
  return `// Sign an Ordinate Assistant link on your server. Node 18+, no packages.
const crypto = require('node:crypto');

const ORDINATE = ${JSON.stringify(i.server.replace(/\/+$/, ''))};
const SECRET = process.env.ORDINATE_EMBED_SECRET; // from Admin → Embedding

// Per page view, for the signed-in customer. \`sub\` is their id in your product; \`params\` locks every question to their own rows.
function assistantUrl(user, minutes = 30) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT', kid: ${JSON.stringify(i.org)} });
  const body = b64({ ...${claims(i)}, exp: Math.floor(Date.now() / 1000) + minutes * 60 }); // at most 60 minutes
  const sig = crypto.createHmac('sha256', SECRET).update(head + '.' + body).digest('base64url');
  return ORDINATE + '/embed/ask/' + head + '.' + body + '.' + sig;
}
`;
}

export function pythonAssistantSnippet(i: AssistantSnippetInput): string {
  const params = (i.columns?.length ? i.columns : ['customer_id']).map((c) => `${JSON.stringify(c)}: [user["customer_id"]]`).join(', ');
  return `# Sign an Ordinate Assistant link on your server. Python 3, standard library only.
import base64, hashlib, hmac, json, os, time

ORDINATE = ${JSON.stringify(i.server.replace(/\/+$/, ''))}
SECRET = os.environ["ORDINATE_EMBED_SECRET"]  # from Admin → Embedding

def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).rstrip(b"=").decode()

# Per page view, for the signed-in customer. "sub" is their id in your product; "params" locks every question to their own rows.
def assistant_url(user, minutes=30):
    head = b64({"alg": "HS256", "typ": "JWT", "kid": ${JSON.stringify(i.org)}})
    body = b64({"agent": ${JSON.stringify(i.agentId ?? '<agent id>')}, "sub": str(user["id"]), "params": {${params}}, "exp": int(time.time()) + minutes * 60})  # at most 60 minutes
    sig = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), (head + "." + body).encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    return ORDINATE + "/embed/ask/" + head + "." + body + "." + sig
`;
}

export function iframeSnippet(): string {
  return `<iframe src="<?= assistantUrl(user) ?>" title="Ask about your data"
  style="width:100%;height:640px;border:0" referrerpolicy="no-referrer"></iframe>
<!-- Your site must be listed under "Who may frame" in Admin → Embedding. -->`;
}
