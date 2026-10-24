// The route that opens one comment thread where it lives (`?comment=<kind>:<id>`,
// which the record's comment door or the dashboard reads on arrival) — pure, and
// shared: Home's lists and the mention notice (web) and the mention email's link
// (server) all build it here.

export type ThreadKind = 'analysis' | 'card' | 'visual' | 'dataset' | 'story';

/** The app route of a thread, or null for a card no longer on any dashboard. */
export function threadPath(projectId: string, target: { kind: ThreadKind; id: string }, analysisId?: string | null): string | null {
  const q = `comment=${target.kind}:${target.id}`;
  if (target.kind === 'dataset') return `/data/${projectId}/${target.id}?${q}`;
  if (target.kind === 'visual') return `/visuals/${projectId}/${target.id}?${q}`;
  if (target.kind === 'story') return `/stories/${projectId}/${target.id}?${q}`;
  const aid = target.kind === 'analysis' ? target.id : analysisId;
  return aid ? `/analyses/${projectId}/${aid}?${q}` : null;
}
