// The one small model call of the router, when two agents fit about equally (docs/agent-router/00-design.md, Q1). It is sent
// the question, and the two agents' names and descriptions: nothing else (no data, no instructions, no documents, no
// history). The model only says which number. It never writes a reason or a figure.

export const ROUTE_SYSTEM = [
  'You pick which of two assistants should answer a question, by reading what each says it is for.',
  'Reply with one character: 1 or 2. Reply 0 when neither is clearly better. Say nothing else.',
].join(' ');

export interface Candidate { name: string; description: string }

const one = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function routeUser(question: string, a: Candidate, b: Candidate): string {
  const line = (n: number, c: Candidate): string => `${n}. ${one(c.name)}${c.description ? ` - ${one(c.description)}` : ''}`;
  return `Question: ${one(question)}\n\nAssistants:\n${line(1, a)}\n${line(2, b)}`;
}

/** 0 (first), 1 (second) or null (neither, or a reply that is not one character of 0, 1, 2). */
export function parseRoute(raw: string | undefined): 0 | 1 | null {
  const m = /^\s*([012])\s*$/.exec(raw ?? '');
  return m ? (m[1] === '1' ? 0 : m[1] === '2' ? 1 : null) : null;
}
