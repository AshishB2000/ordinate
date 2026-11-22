// /autopilot/:projectId/:runId — one Autopilot run's report (docs/autopilot/00-design.md, phase 4): what it moved to Trash, what it
// repaired, what is broken or slow. Every row has Undo (a move, a repair) or Open. Org admins only: the server refuses anyone else.

import { Link, useParams } from 'react-router';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Badge, type BadgeTone } from '../../ui/Badge';
import { Button, buttonClass } from '../../ui/Button';
import { dayInYear } from '../data/format';
import { useRun, useRuns, useUndo, type Item, type ItemKind } from './api';
import { describe, stateWord } from './words';
import s from './Autopilot.module.css';

const TITLES: Record<ItemKind, string> = { trashed: 'Moved to Trash', repaired: 'Repaired', broken: 'Broken, for you to fix', slow: 'Slow' };
const when = (iso: string): string => dayInYear.format(new Date(iso));

function Row({ it, onUndo, busy, projectId }: { it: Item; onUndo: () => void; busy: boolean; projectId: string }) {
  const { words, sub } = describe(it, '');
  const undoable = it.state === 'applied' && (it.kind === 'trashed' || it.kind === 'repaired');
  return (
    <li className={s.row} data-kind={it.kind} data-state={it.state}>
      <div className={s.what}>
        <span className={s.chart}>{it.name || 'Untitled'}</span>
        <span className={s.words}>{words}</span>
        {sub && <span className={s.sub}>{sub}</span>}
      </div>
      {it.state === 'undone' && <Badge tone="neutral">Undone</Badge>}
      {it.state === 'failed' && <Badge tone="error">Not done</Badge>}
      {undoable && <Button size="sm" icon="rotate-ccw" onClick={onUndo} loading={busy} aria-label={`Undo for ${it.name}`}>Undo</Button>}
      {it.state === 'applied' && it.kind === 'trashed' ? (
        <Link className={buttonClass('ghost', 'sm')} to={`/trash?project=${projectId}`}>Open Trash</Link>
      ) : (
        it.state !== 'undone' && <Link className={buttonClass('ghost', 'sm')} to={`/visuals/${projectId}/${it.visualId}`} aria-label={`Open ${it.name}`}>Open</Link>
      )}
    </li>
  );
}

export default function ReportPage() {
  const { projectId, runId } = useParams();
  const q = useRun(projectId, runId);
  const runs = useRuns(projectId);
  const undo = useUndo(projectId ?? '', runId ?? '');
  const back = { to: '/admin?tab=autopilot', label: 'Autopilot' };
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <Page title="Autopilot report" back={back}><ErrorState title="This report could not be opened" message={q.error.message} onRetry={() => void q.refetch()} /></Page>;
  const { run, items } = q.data;
  const group = (k: ItemKind) => items.filter((i) => i.kind === k);
  const applied = items.filter((i) => i.kind === 'repaired' && i.state === 'applied').length;
  const tone: BadgeTone = run.state === 'paused' || run.state === 'failed' ? 'warn' : 'ok';
  const count = (k: string): number => run.counts[k] ?? 0;
  return (
    <Page
      title="Autopilot report"
      back={back}
      status={<Badge tone={tone}>{stateWord(run)}</Badge>}
      sub={`${run.manual ? 'Run now' : `Week of ${run.week ? when(run.week) : ''}`}${run.ranAs ? `, as ${run.ranAs}` : ''}, ${when(run.startedAt)}`}
      actions={applied > 0 ? <Button icon="rotate-ccw" loading={undo.isPending && undo.variables === undefined} onClick={() => undo.mutate(undefined)}>Undo all repairs</Button> : undefined}
    >
      <div className={s.stats}>
        <span className={s.stat}><b>{count('trashed')}</b> moved to Trash</span>
        <span className={s.stat}><b>{count('repaired')}</b> repaired</span>
        <span className={s.stat}><b>{count('broken')}</b> broken</span>
        <span className={s.stat}><b>{count('slow')}</b> slow</span>
      </div>
      {run.state === 'paused' && <p className={s.pause} role="status">Autopilot stopped without changing anything: {run.ranAs} switched it on and is no longer an admin. An admin can switch it on again from Admin.</p>}
      {run.state === 'done' && items.length === 0 && (
        <EmptyState icon="check" title="Nothing to do this time">
          {run.coveredFrom && run.coveredFrom > run.startedAt.slice(0, 10)
            ? `Autopilot is still watching. It starts calling charts unused on ${dayInYear.format(new Date(`${run.coveredFrom}T12:00:00`))}.`
            : 'No chart was unused, broken or slow.'}
        </EmptyState>
      )}
      {(['trashed', 'repaired', 'broken', 'slow'] as const).map((k) => group(k).length > 0 && (
        <section key={k} aria-label={TITLES[k]}>
          <h2 className={s.sectionTitle}>{TITLES[k]}</h2>
          <ul className={s.list}>
            {group(k).map((it) => <Row key={it.seq} it={it} projectId={run.projectId} busy={undo.isPending && undo.variables === it.seq} onUndo={() => undo.mutate(it.seq)} />)}
          </ul>
        </section>
      ))}
      {(runs.data?.length ?? 0) > 1 && (
        <section aria-label="Earlier reports">
          <h2 className={s.sectionTitle}>Earlier reports</h2>
          <div className={s.earlier}>
            {runs.data!.filter((r) => r.id !== run.id).map((r) => (
              <Link key={r.id} className={buttonClass('ghost', 'sm')} to={`/autopilot/${r.projectId}/${r.id}`}>{when(r.startedAt)}{r.manual ? ' (run now)' : ''}</Link>
            ))}
          </div>
        </section>
      )}
    </Page>
  );
}
