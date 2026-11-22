// The note an Auto-routed answer keeps (docs/agent-router/00-design.md, "What is stored"): why this agent answered, in the
// app's own words from the matches it found (./agentRouteMessages). Never a model's guess. The sanitizer in ./copilot keeps
// only this key, as one line.

export interface RouteNote { why: string }

const MAX_WHY = 300;

export function sanitizeRoute(raw: unknown): RouteNote | undefined {
  const w = raw && typeof raw === 'object' ? (raw as { why?: unknown }).why : undefined;
  const why = typeof w === 'string' ? w.replace(/\s+/g, ' ').trim().slice(0, MAX_WHY) : '';
  return why ? { why } : undefined;
}
