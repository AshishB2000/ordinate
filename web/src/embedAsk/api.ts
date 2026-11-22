// The embedded Assistant page's one server call (docs/embedded-assistant): POST /embed/ask with the signed token in the BODY. No wire
// codec, no RPC client, no session: this page has none, and must stay small (web/scripts/bundle-size.ts holds its own budget).

/** The card as the server whitelists it (src/ipc/embedAsk.ts EmbedCard): figures computed on the server, drawn here. */
export interface Card {
  title: string;
  chartType: string;
  datasetName: string;
  data: { labels: (string | number)[]; series: { name: string; values: (number | null)[]; role?: 'overlay'; target?: true }[] };
  caption: string;
  headline: { label: string; value: number; display: string }[];
  bullets: string[];
  filterLabels: string[];
  notes: string[];
}

export type Turn = { role: 'user'; text: string } | { role: 'assistant'; text: string; card: Card | null } | { role: 'error'; text: string; retryAfter?: number };

export type Reply = { ok: true; text: string; card: Card | null } | { ok: false; error: string; retryAfter?: number };

/** `/embed/ask/<token>` → the token, or null. */
export function tokenFromPath(pathname: string): string | null {
  const m = /^\/embed\/ask\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m ? m[1] : null;
}

/** What the server is sent as the conversation so far: text only (it never trusts more). */
export function historyOf(turns: readonly Turn[]): { role: 'user' | 'assistant'; text: string }[] {
  return turns.flatMap((t) => (t.role === 'user' || t.role === 'assistant' ? [{ role: t.role, text: t.text }] : [])).slice(-10);
}

const FAILED = 'The assistant could not answer. Try again.';

export async function ask(token: string, question: string, history: { role: string; text: string }[], fetcher: typeof fetch = fetch): Promise<Reply> {
  let res: Response;
  try {
    res = await fetcher('/embed/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, question, history }), cache: 'no-store' });
  } catch {
    return { ok: false, error: FAILED };
  }
  type Body = { ok?: unknown; error?: unknown; text?: unknown; card?: unknown };
  const body: Body | null = await res.json().then((j: Body) => j, () => null);
  if (body && body.ok === true && typeof body.text === 'string') return { ok: true, text: body.text, card: (body.card as Card | null) ?? null };
  const wait = Number(res.headers.get('retry-after'));
  return { ok: false, error: typeof body?.error === 'string' && body.error ? body.error : FAILED, ...(res.status === 429 && wait > 0 ? { retryAfter: wait } : {}) };
}
