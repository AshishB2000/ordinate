// The parts of a move (docs/team-folders, "The move warning"): where it can go, the warning the server computed
// (`folder:moveImpact`), and that warning in words. Every count is the server's; this only phrases it.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { rpc } from '../../api/client';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { childrenOf, editsFolder, EVERYONE, people, type Failed, type FolderTree, type MoveImpact, type PlacedKind } from './api';
import s from './Folders.module.css';

export interface Line {
  tone: 'lose' | 'gain' | 'info';
  icon: IconName;
  text: ReactNode;
}

const who = (team: string | null, n: number, everyoneWord: string): ReactNode => (
  <>
    <strong>{team ?? everyoneWord}</strong> ({people(n)})
  </>
);

/** The warning, a line per thing that changes — the design's sentences. `it`: "it" or "them". */
export function impactLines(m: MoveImpact): Line[] {
  const many = m.moving.datasets + m.moving.dashboards > 1;
  const it = many ? 'them' : 'it';
  const out: Line[] = [];
  for (const g of m.lose) out.push({ tone: 'lose', icon: 'lock', text: <>{who(g.team, g.people, `Everyone else in the project`)} will lose access.</> });
  for (const g of m.gain) out.push({ tone: 'gain', icon: 'user', text: <>{who(g.team, g.people, EVERYONE)} will be able to open {it}.</> });
  if (m.viewOnly) out.push({ tone: 'lose', icon: 'eye', text: <><strong>{people(m.viewOnly)}</strong> will only be able to view {it}.</> });
  if (m.canEdit) out.push({ tone: 'gain', icon: 'pencil', text: <><strong>{people(m.canEdit)}</strong> will be able to edit {it}.</> });
  if (m.published) {
    out.push({ tone: 'info', icon: 'globe', text: m.published === 1 && !many ? 'It has a published link: everyone the link was shared with can still open that page.' : `${m.published} of these have published links: everyone those links were shared with can still open those pages.` });
  }
  if (m.recipients) out.push({ tone: 'lose', icon: 'send', text: <><strong>{m.recipients === 1 ? '1 subscription recipient' : `${m.recipients} subscription recipients`}</strong> will stop receiving {it}.</> });
  if (m.reachers.dashboards) {
    const boards = m.reachers.dashboards === 1 ? '1 dashboard in another folder shows' : `${m.reachers.dashboards} dashboards in other folders show`;
    out.push({
      tone: m.reachers.keeps ? 'info' : 'lose',
      icon: 'layout-dashboard',
      text: m.reachers.keeps
        ? `${boards} its charts: their viewers keep seeing those charts.`
        : `${boards} its charts: their viewers will stop seeing those charts, because ${m.to ?? 'the destination'} does not let other folders show its data.`,
    });
  }
  if (!out.length) out.push({ tone: 'info', icon: 'circle-check', text: 'Nobody gains or loses access. Who can open it stays the same.' });
  return out;
}

/** The warning for moving `items` (and everything placed in `from`) to `to`; asks nothing until both are known. */
export function useImpact(projectId: string, items: ReadonlyArray<{ kind: PlacedKind; id: string }>, to: string | null, from?: string, enabled = true) {
  return useQuery({
    queryKey: ['folder:moveImpact', projectId, items.map((i) => `${i.kind}:${i.id}`).join(','), to, from ?? null],
    queryFn: async () => (await rpc('folder:moveImpact', { projectId, items: items.map(({ kind, id }) => ({ kind, id })), to: to as string, ...(from ? { from } : {}) })) as MoveImpact | Failed,
    enabled: enabled && !!to && (items.length > 0 || !!from),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** The warning as it loads: nothing picked yet, a skeleton, a refusal in the server's words, or its lines. */
export function ImpactPanel({ query, picked }: { query: UseQueryResult<MoveImpact | Failed>; picked: boolean }) {
  let body: ReactNode;
  if (!picked) body = <p className={s.hint}>Pick where it goes to see who gains or loses access before anything moves.</p>;
  else if (query.isPending) body = <SkeletonRows rows={2} label="Working out who gains and loses access" />;
  else if (query.isError) body = <ErrorState compact heading={3} title="This move can't be checked" message={query.error.message} onRetry={() => void query.refetch()} />;
  else if (!query.data.ok) body = <ErrorState compact heading={3} title="This move can't be checked" message={query.data.error} />;
  else {
    body = (
      <ul className={s.lines} aria-label="What changes">
        {impactLines(query.data).map((l, i) => (
          <li key={i} className={s.line} data-tone={l.tone}>
            <span className={s.lineIc} aria-hidden="true">
              <Icon name={l.icon} size={12} />
            </span>
            <span className={s.lineText}>{l.text}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section className={s.impact} aria-live="polite">
      <h3 className={s.impactHead}>What changes</h3>
      {body}
    </section>
  );
}

/**
 * Where things can go: Everyone, then every folder in tree order, nested. Folders the caller cannot add to (Can view, or
 * an admin-only lock they still edit as an admin) are offered only when they edit them; `current` is marked.
 */
export function Destinations({ projectId, tree, value, onChange, current, exclude }: {
  projectId: string;
  tree: FolderTree;
  value: string | null;
  onChange: (id: string) => void;
  current?: string;
  exclude?: (id: string) => boolean;
}) {
  const rows: Array<{ id: string; name: string; depth: number; icon: IconName }> = [{ id: projectId, name: EVERYONE, depth: 0, icon: 'home' }];
  const walk = (parent: string, depth: number) => {
    for (const f of childrenOf(tree, parent)) {
      rows.push({ id: f.id, name: f.name, depth, icon: f.adminOnly ? 'lock' : 'folder' });
      walk(f.id, depth + 1);
    }
  };
  walk(projectId, 1);
  for (const f of childrenOf(tree, null)) {
    rows.push({ id: f.id, name: f.name, depth: 0, icon: f.adminOnly ? 'lock' : 'folder' });
    walk(f.id, 1);
  }
  return (
    <ul className={s.dests} role="radiogroup" aria-label="Destination">
      {rows.map((r) => {
        const here = r.id === current;
        const edits = editsFolder(tree, projectId, r.id);
        const can = edits && !exclude?.(r.id);
        return (
          <li key={r.id}>
            <button
              type="button"
              role="radio"
              aria-checked={value === r.id}
              data-depth={r.depth || undefined}
              className={s.dest}
              disabled={here || !can}
              onClick={() => onChange(r.id)}
            >
              <Icon name={r.icon} size={16} />
              <span>{r.name}</span>
              {here ? <span className={s.destNote}>Where it is now</span> : !edits && <span className={s.destNote}>Can view</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
