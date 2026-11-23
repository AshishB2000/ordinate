// The Tests section (docs/eval-suites/00-design.md, phases 2 to 4), on Model → Assistant (the Project assistant's suites) and on an
// agent's page (that agent's). A suite is a saved list of questions; Run asks every one through the real Assistant as you, and the
// engine checks each answer. A run happens only when an editor presses Run: after the assistant's instructions, documents or model change
// the section says so and offers it. Editors and admins only: a viewer never sees it.

import { useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { ConfirmDelete } from '../../ui/ConfirmDelete';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { dayInYear } from '../data/format';
import { PART_TEXT, useEvalCall, useSuites, type SuiteRow } from './api';
import { RunCard } from './RunCard';
import { SuiteCases } from './SuiteCases';
import s from './Evals.module.css';
import a from '../assistant/setup/Assistant.module.css';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function Row({ projectId, suite, busy, onOpen, onRun, onRemove }: { projectId: string; suite: SuiteRow; busy: boolean; onOpen: () => void; onRun: () => void; onRemove: () => void }) {
  const l = suite.last;
  const stale = suite.stale.map((p) => PART_TEXT[p] ?? p);
  const running = !!suite.runningId;
  return (
    <li className={s.suite} data-testid="suite-row">
      <div className={s.suiteMain}>
        <span className={s.mark} aria-hidden="true"><Icon name="circle-check" size={16} /></span>
        <div className={s.suiteText}>
          <button type="button" className={s.suiteName} onClick={onOpen} aria-label={`Open ${suite.name}`}>{suite.name}</button>
          <p className={s.caseMeta}>
            {plural(suite.caseCount, 'test case')}
            {l ? ' · ' : ''}
            {l && (
              <Link to={`/evals/${projectId}/${l.runId}`} className={s.link}>
                {`Last run ${Number.isNaN(Date.parse(l.startedAt)) ? '' : dayInYear.format(new Date(l.startedAt))}: ${l.passed} passed, ${l.failed} failed${l.notScored ? `, ${l.notScored} not scored` : ''}`}
              </Link>
            )}
            {!l && ' · not run yet'}
          </p>
          {stale.length > 0 && !running && (
            <p className={s.stale} role="status">
              <Icon name="alert" size={12} />
              {`${stale.join(' and ')} since the last run. Run the tests to see what changed.`}
            </p>
          )}
        </div>
        <span className={s.rowActions}>
          <Button size="sm" variant={stale.length && !running ? 'primary' : 'secondary'} icon="play" loading={busy} disabled={running || !suite.caseCount} onClick={onRun}>
            Run tests
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpen}>Cases</Button>
          <IconButton icon="trash" size="sm" label={`Delete ${suite.name}`} onClick={onRemove} />
        </span>
      </div>
      {suite.liveQueries > 0 && !running && (
        <p className={s.help}>
          <Icon name="info" size={12} />
          {`A run makes up to ${suite.liveQueries} warehouse queries on Live data: the answer, the expected figure and the answer’s figure, for each Live case.`}
        </p>
      )}
      {running && suite.runningId && <RunCard projectId={projectId} runId={suite.runningId} />}
    </li>
  );
}

/** `agentId`: the assistant these suites are for; null: the Project assistant. */
export function TestsSection({ projectId, agentId }: { projectId: string; agentId: string | null }) {
  const q = useSuites(projectId);
  const call = useEvalCall(projectId);
  const [open, setOpen] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<SuiteRow | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const suites = (q.data?.suites ?? []).filter((x) => x.agentId === agentId);
  const other = q.data?.activeRunId && !suites.some((x) => x.runningId === q.data?.activeRunId);

  async function make(): Promise<void> {
    const r = await call<{ ok: true; id: string }>('eval:suiteSave', { name: name.trim(), agentId });
    if (!r.ok) return setProblem(r.error || 'The suite could not be made.');
    setMaking(false);
    setName('');
    setProblem('');
    setOpen(r.id);
  }
  async function run(suite: SuiteRow): Promise<void> {
    setStarting(suite.id);
    setProblem('');
    const r = await call('eval:runStart', { suiteId: suite.id });
    setStarting(null);
    if (!r.ok) setProblem(r.error || 'The tests could not be started.');
  }
  async function remove(): Promise<void> {
    if (!removing) return;
    const r = await call('eval:suiteDelete', { id: removing.id });
    if (!r.ok) toast(r.error || 'The suite could not be deleted.', { kind: 'error' });
    setRemoving(null);
  }

  let body;
  if (q.isPending) body = <SkeletonRows rows={2} label="Loading the tests" />;
  else if (q.isError) body = <ErrorState heading={3} title="The tests could not be loaded" message={q.error.message || 'Try again.'} onRetry={() => void q.refetch()} />;
  else if (q.data && !q.data.available) {
    body = (
      <EmptyState icon="database" heading={3} title="Tests need a database">
        This server runs without Postgres, where test suites are off. Set DATABASE_URL to use them.
      </EmptyState>
    );
  } else if (!suites.length) {
    body = (
      <EmptyState icon="circle-check" heading={3} title="No tests yet" actions={<Button variant="primary" icon="plus" onClick={() => setMaking(true)}>New suite</Button>}>
        {agentId ? 'A suite is a list of questions this assistant should answer well.' : 'A suite is a list of questions the Project assistant should answer well.'} Add a verified question or a good answer with “Add to tests”, run them after you change instructions, documents or the model, and see which answers got better or worse. The app checks every figure itself.
      </EmptyState>
    );
  } else {
    body = (
      <div className={a.card}>
        <ul className={s.suites} aria-label="Test suites">
          {suites.map((x) => (
            <Row key={x.id} projectId={projectId} suite={x} busy={starting === x.id} onOpen={() => setOpen(x.id)} onRun={() => void run(x)} onRemove={() => setRemoving(x)} />
          ))}
        </ul>
      </div>
    );
  }
  return (
    <section className={a.section} aria-labelledby={`tests-${agentId ?? 'project'}-h`}>
      <div className={a.head}>
        <div>
          <div className={a.titleRow}>
            <h2 className={a.title} id={`tests-${agentId ?? 'project'}-h`}>Tests</h2>
            {!!suites.length && <Badge>{suites.length}</Badge>}
          </div>
          <p className={a.sub}>Questions to ask {agentId ? 'this assistant' : 'the Project assistant'} again and again. Run them after a change; the engine checks every figure.</p>
        </div>
        {q.data?.available && !!suites.length && <Button variant="primary" icon="plus" onClick={() => setMaking(true)}>New suite</Button>}
      </div>
      {other && <p className={s.help}><Icon name="info" size={12} />Another suite in this project is running. One run goes at a time.</p>}
      {problem && <p className={s.problem} role="alert">{problem}</p>}
      {body}
      {open && <SuiteCases projectId={projectId} suiteId={open} onClose={() => setOpen(null)} />}
      {making && (
        <Dialog
          open
          onOpenChange={(o) => !o && setMaking(false)}
          size="sm"
          title="New suite"
          footer={
            <>
              <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
              <Button variant="primary" disabled={!name.trim()} onClick={() => void make()}>Make suite</Button>
            </>
          }
        >
          <Input label="Name" value={name} maxLength={80} placeholder="Revenue questions" autoFocus onChange={(e) => setName(e.target.value)} />
        </Dialog>
      )}
      {removing && (
        <ConfirmDelete
          title={`Delete “${removing.name}”?`}
          description="Its test cases and the results of its runs go with it."
          confirm="Delete"
          onConfirm={() => void remove()}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
