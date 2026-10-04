// /analytics/scenarios/:projectId/compare?ids=… — COMPARE SCENARIOS
// (scenarioCompare.ts): the baseline and up to four saved scenarios side by
// side, one row per metric (the union of the scenarios' metrics), every cell
// the figure and its change on the baseline. The figures — and which column
// of a row is best — come from `scenario:compare`.

import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { ErrorState, PageSkeleton } from '../../../app/blocks';
import { buttonClass } from '../../../ui/Button';
import { SkeletonTable } from '../../../ui/Skeleton';
import { Icon } from '../../../ui/icons/Icon';
import { useAdoptProject } from '../../projects/current';
import { call, useScenarios, type CompareReply } from '../api';
import { fmtPct } from '../format';
import { DriverChips, NewScenario, TornadoArt } from './ScenarioParts';
import s from './Scenarios.module.css';

const MAX = 4;

function Empty({ title, text, projectId }: { title: string; text: string; projectId?: string }) {
  return (
    <div className={s.empty}>
      <TornadoArt className={s.emptyArt} />
      <h2 className={s.emptyH}>{title}</h2>
      <p className={s.emptyP}>{text}</p>
      {projectId && <NewScenario projectId={projectId} />}
    </div>
  );
}

function Table({ res, projectId }: { res: CompareReply; projectId: string }) {
  const cols = `minmax(150px, 1.1fr) repeat(${res.scenarios.length + 1}, minmax(150px, 1fr))`;
  return (
    <div className={s.cmpTable} role="table" aria-label="Baseline and scenarios, side by side">
      <div className={`${s.cmpRow} ${s.cmpHeadRow}`} role="row" style={{ gridTemplateColumns: cols }}>
        <div className={`${s.cmpCell} ${s.cmpCorner}`} role="columnheader">
          Metric
        </div>
        <div className={`${s.cmpCell} ${s.cmpColhead} ${s.cmpBase}`} role="columnheader">
          <span className={s.cmpColname}>Baseline</span>
          <span className={s.cmpColsub}>The data as stored</span>
        </div>
        {res.scenarios.map((sc) => (
          <div key={sc.id} className={`${s.cmpCell} ${s.cmpColhead}`} role="columnheader">
            <Link className={`${s.cmpColname} ${s.cmpOpen}`} to={`/analytics/scenarios/${projectId}/${sc.id}`} title={`Open ${sc.name}`}>
              {sc.name}
            </Link>
            <span className={s.cmpDrivers}>
              <DriverChips names={sc.drivers} none="No drivers" />
            </span>
          </div>
        ))}
      </div>
      {res.rows.map((r) => (
        <div key={r.metricId} className={r.missing ? `${s.cmpRow} ${s.isMissing}` : s.cmpRow} role="row" style={{ gridTemplateColumns: cols }}>
          <div className={`${s.cmpCell} ${s.cmpMetric}`} role="rowheader">
            {r.missing ? 'Missing metric' : r.name}
          </div>
          <div className={`${s.cmpCell} ${s.cmpVal} ${s.cmpValBase}`} role="cell">
            {r.baselineDisplay || '—'}
          </div>
          {r.cells.map((c, i) => {
            const tone = c.delta === null || c.delta === 0 ? 'flat' : c.tone;
            return (
              <div key={i} className={i === r.best ? `${s.cmpCell} ${s.cmpVal} ${s.isBest}` : `${s.cmpCell} ${s.cmpVal}`} role="cell">
                <span className={s.cmpNum}>{c.display || '—'}</span>
                {c.delta !== null && (
                  <span className={`${s.cmpDelta} ${s[tone]}`}>{c.delta === 0 ? 'No change' : c.deltaDisplay + (typeof c.pct === 'number' ? ` (${fmtPct(c.pct)})` : '')}</span>
                )}
                {i === r.best && <span className={s.cmpBest}>Best</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Compare({ projectId }: { projectId: string }) {
  const list = useScenarios(projectId);
  const [params] = useSearchParams();
  const [picked, setPicked] = useState<string[] | null>(null);
  const all = list.data ?? [];
  // First visit: what the link asked for, topped up to two.
  const chosen =
    picked ??
    (() => {
      const want = (params.get('ids') ?? '').split(',').filter((id) => all.some((x) => x.id === id));
      for (const x of all) if (want.length < Math.min(MAX, 2) && !want.includes(x.id)) want.push(x.id);
      return want;
    })();
  const q = useQuery({
    queryKey: ['scenario:compare', projectId, chosen],
    queryFn: () => call<CompareReply>(rpc('scenario:compare', { projectId, ids: chosen }), 'Could not compare the scenarios.'),
    enabled: chosen.length > 0,
    placeholderData: keepPreviousData,
  });
  const full = chosen.length >= MAX;
  let body;
  if (list.isPending) body = <SkeletonTable rows={4} cols={3} label="Loading scenarios" />;
  else if (list.isError) body = <ErrorState title="Scenarios could not be loaded" message={list.error.message} onRetry={() => void list.refetch()} />;
  else if (!all.length) body = <Empty projectId={projectId} title="Nothing to compare yet" text="Save a scenario or two — a price rise, a volume dip — and see them here side by side with the baseline." />;
  else if (!chosen.length) body = <Empty title="Pick scenarios to compare" text={`Choose up to ${MAX} above. Each becomes a column beside the baseline.`} />;
  else if (!q.data) body = <SkeletonTable rows={4} cols={chosen.length + 2} label="Comparing the scenarios" />;
  else if (!q.data.ok) body = <ErrorState title="Could not compare the scenarios" message={q.data.error} onRetry={() => void q.refetch()} />;
  else body = <Table res={q.data} projectId={projectId} />;
  return (
    <div className={s.page}>
      <div className={s.head}>
        <Link className={buttonClass('secondary', 'sm')} to={`/analytics/scenarios/${projectId}`}>
          <Icon name="arrow-left" />
          Back
        </Link>
        <h1 className={s.cmpTitle}>Compare scenarios</h1>
        <span className={s.cmpCount} aria-live="polite">{`${chosen.length} of ${MAX} picked`}</span>
      </div>
      {all.length > 0 && (
        <div className={s.cmpPick} role="group" aria-label="Scenarios to compare">
          {all.map((x) => {
            const on = chosen.includes(x.id);
            return (
              <button
                key={x.id}
                type="button"
                className={s.cmpChip}
                aria-pressed={on}
                disabled={!on && full}
                title={!on && full ? 'Four scenarios at a time' : undefined}
                onClick={() => setPicked(on ? chosen.filter((id) => id !== x.id) : [...chosen, x.id])}
              >
                <Icon name={on ? 'check' : 'plus'} size={12} /> {x.name}
              </button>
            );
          })}
        </div>
      )}
      <div className={q.isFetching && q.data ? `${s.cmpBody} ${s.isLoading}` : s.cmpBody}>{body}</div>
    </div>
  );
}

export default function ScenarioComparePage() {
  const { projectId } = useParams();
  useAdoptProject(projectId);
  if (!projectId) return <PageSkeleton />;
  return <Compare projectId={projectId} />;
}
