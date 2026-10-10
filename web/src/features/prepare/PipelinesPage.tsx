// /pipelines — every scheduled or dependent thing in the CURRENT project as one
// DAG, with its schedule, retry policy and Run all (legacy pipelinesPage.ts; the
// desktop's Data-page tab). The shell's project switcher picks the project;
// /pipelines/:projectId is a deep link that adopts its project. The server
// builds the graph and every figure on it; live run state arrives over SSE
// (`pipelines:changed`) and re-reads the view.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { onServerEvent } from '../../api/events';
import { EmptyState, ErrorState, Page } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonBlock } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { ProjectGate } from '../import/ProjectGate';
import { useCanEdit } from '../projects/api';
import { useAdoptProject } from '../projects/current';
import { pipelineKey, runPipeline, setNodeSchedule, setPaused, setPolicy, setSchedule, usePipeline, type PipelineView } from './pipelinesApi';
import { PipelineHead } from './PipelineHead';
import { PipelinesDetail, type DetailActions } from './PipelinesDetail';
import { PipelinesGraph } from './PipelinesGraph';
import s from './Pipelines.module.css';

const TITLE = 'Pipelines';
const SUB = 'Refreshes, the SQL datasets built on them, quality checks, alerts, reports and publishes — one pipeline you can schedule, run and watch.';

export default function PipelinesPage() {
  const { projectId: linked } = useParams();
  useAdoptProject(linked);
  return (
    <ProjectGate title={TITLE} sub={SUB} why="A pipeline belongs to a project.">
      {(current) => <Pipeline key={linked ?? current} projectId={linked ?? current} />}
    </ProjectGate>
  );
}

function Pipeline({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const q = usePipeline(projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<Record<string, string> | null>(null);
  const reload = () => void qc.invalidateQueries({ queryKey: pipelineKey(projectId) });
  const canEdit = useCanEdit(projectId);

  // A run in this org (any tab, any pod) pushes its live state; the view is re-read just after.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onServerEvent('pipelines:changed', (p) => {
      const o = p as { projectId?: string; live?: Record<string, string> } | null;
      if (!o || o.projectId !== projectId) return;
      setLive(o.live ?? {});
      clearTimeout(t);
      t = setTimeout(() => void qc.invalidateQueries({ queryKey: pipelineKey(projectId) }), 150);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [projectId, qc]);

  async function save(p: Promise<{ ok: boolean; error?: string }>, fallback: string) {
    const r = await p.catch(() => null);
    if (!r || !r.ok) toast((r && !r.ok && r.error) || fallback, { kind: 'error' });
    reload();
    return !!r?.ok;
  }

  async function run(nodeId?: string) {
    if (running) return;
    setRunning(true);
    const r = await runPipeline(projectId, nodeId).catch(() => null);
    setRunning(false);
    setLive(null);
    if (!r || !r.ok) toast((r && !r.ok && r.error) || 'The pipeline could not run.', { kind: 'error' });
    else if (r.failed) {
      const stopped = r.blocked ? `, ${r.blocked} stopped after ${r.failed === 1 ? 'it' : 'them'}` : '';
      toast(`${r.failed} ${r.failed === 1 ? 'step' : 'steps'} failed${stopped}. An alert was raised.`, { kind: 'error' });
    } else toast(`Pipeline ran — ${r.done} ${r.done === 1 ? 'step' : 'steps'} done.`, { kind: 'success' });
    reload();
  }

  const act: DetailActions = {
    canEdit,
    running,
    run: (id) => void run(id),
    pause: (id, paused) => void save(setPaused(projectId, id, paused), 'Could not save.'),
    setNode: (id, patch) => void save(setNodeSchedule(projectId, id, patch), 'Could not save the schedule.'),
  };

  const view = q.data;
  return (
    <Page title={TITLE} sub={SUB}>
      {q.isPending ? (
        <div className={s.loading} aria-busy="true">
          <SkeletonBlock label="Reading the pipeline" />
        </div>
      ) : q.isError || !view ? (
        <ErrorState title="Could not read the pipeline" message={q.error?.message ?? 'Something went wrong reading this project’s records. Try again in a moment.'} onRetry={reload} />
      ) : !view.ok ? (
        view.cycle ? (
          <EmptyState icon="lineage" title="This pipeline has a loop">
            {view.error} Nothing runs until one of them stops reading the other.
            {view.cycle.length > 0 && <span className={s.cycle}>{[...view.cycle, view.cycle[0]].join('  →  ')}</span>}
          </EmptyState>
        ) : (
          <ErrorState title="Could not read the pipeline" message={view.error} onRetry={reload} />
        )
      ) : (
        <Ready
          projectId={projectId}
          view={view}
          live={live ?? view.live}
          selected={selected && view.nodes.some((n) => n.id === selected) ? selected : null}
          onSelect={setSelected}
          act={act}
          onRunAll={() => void run()}
          saveSchedule={(patch) => save(setSchedule(projectId, patch), 'Could not save the schedule.')}
          savePolicy={(retries, backoffMs) => void save(setPolicy(projectId, retries, backoffMs), 'Could not save the retry policy.')}
        />
      )}
    </Page>
  );
}

function Ready({
  projectId,
  view,
  live,
  selected,
  onSelect,
  act,
  onRunAll,
  saveSchedule,
  savePolicy,
}: {
  projectId: string;
  view: PipelineView;
  live: Record<string, string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  act: DetailActions;
  onRunAll: () => void;
  saveSchedule: (patch: { cron?: string | null; tz?: string; paused?: boolean }) => Promise<boolean>;
  savePolicy: (retries: number, backoffMs: number) => void;
}) {
  return (
    <>
      <PipelineHead view={view} running={act.running} canEdit={act.canEdit} onRunAll={onRunAll} saveSchedule={saveSchedule} savePolicy={savePolicy} />
      {view.nodes.length === 0 ? (
        <div className={s.empty}>
          <div className={s.ghostCols} aria-hidden="true">
            {view.stages.map((st) => (
              <div key={st} className={s.col}>
                <div className={s.colH}>{st}</div>
                <div className={s.ghost} />
                <div className={s.ghost} />
              </div>
            ))}
          </div>
          <div className={s.emptyMsg}>
            <EmptyState
              icon="lineage"
              title="Nothing runs on its own yet"
              actions={
                act.canEdit && (
                  <Link className={buttonClass('primary', 'md')} to={`/connections/${projectId}`}>
                    <Icon name="plug" />
                    <span>Connect data</span>
                  </Link>
                )
              }
            >
              Connect a database or import a file you can refresh. Its refreshes, the SQL datasets built on it, quality checks, alerts, reports and publishes
              will line up here as one pipeline you can schedule, run and watch.
            </EmptyState>
          </div>
        </div>
      ) : (
        <>
          <PipelinesGraph view={view} live={live} selected={selected} onSelect={onSelect} />
          <PipelinesDetail projectId={projectId} view={view} selected={selected} act={act} />
        </>
      )}
      {act.running && (
        <p className={s.srOnly} role="status">
          Running the pipeline…
        </p>
      )}
    </>
  );
}
