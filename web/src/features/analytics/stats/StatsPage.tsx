// /analytics/:projectId/:datasetId/stats — the statistics workbench
// (statsPanel.ts): four tabs (Correlation, Regression, Compare groups,
// Distribution), each with its settings column and its result. A tab's spec
// re-runs 250 ms after a change — unless the table is over 200,000 rows, where
// a run is a background job and waits for "Run analysis". `?x=&y=` (a
// scatter's "Statistics…") pre-fills Correlation and Regression with that pair.
//
// Every figure comes from `stats:run` / `stats:pair` (src/ipc/stats.ts). This
// file holds the specs the user is building and lays out the replies.

import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { formatNumber } from '../../../../../src/app/format.ts';
import { rpc } from '../../../api/client';
import type { DatasetColumns } from '../../../api/datasets';
import { Button } from '../../../ui/Button';
import { EmptyState } from '../../../ui/States';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { Tab, TabList, Tabs } from '../../../ui/Tabs';
import { toast } from '../../../ui/Toast';
import { DatasetRoute, WorkbenchHead } from '../Workbench';
import { call, useStatsRun, type GroupsResult, type StatsKind, type StatsSpec } from '../api';
import { AddToDashboard } from './AddToDashboard';
import { CorrelationView } from './StatsCorrelation';
import { StatsControls } from './StatsControls';
import { DistributionView, GroupsView } from './StatsGroups';
import { Problem } from './StatsParts';
import { RegressionView } from './StatsRegression';
import a from '../Analytics.module.css';
import s from './Stats.module.css';

const TABS: Array<[StatsKind, string]> = [
  ['correlation', 'Correlation'],
  ['regression', 'Regression'],
  ['groups', 'Compare groups'],
  ['distribution', 'Distribution'],
];
/** Above this many rows a run is a background job — no auto-run on every click. */
const AUTO_MAX_ROWS = 200_000;

type Specs = Record<StatsKind, StatsSpec>;

/** Sensible starting specs for a dataset's columns (statsPanel.ts swDefaultSpecs). */
function defaults(datasetId: string, columns: DatasetColumns['columns'], pair: [string, string] | null): Specs {
  const num = columns.filter((c) => c.type === 'number').map((c) => c.name);
  // Text columns before dates: a date has hundreds of values, past the 20 groups a comparison takes.
  const cat = [...columns.filter((c) => c.type === 'text'), ...columns.filter((c) => c.type === 'date')].map((c) => c.name);
  const target = num[num.length - 1] || '';
  const base = { datasetId, columns: [] as string[] };
  return {
    correlation: { ...base, kind: 'correlation', columns: pair ? [...pair] : num.slice(0, 6), method: 'pearson' },
    regression: pair
      ? { ...base, kind: 'regression', target: pair[1], predictors: [pair[0]] }
      : { ...base, kind: 'regression', target, predictors: num.filter((c) => c !== target).slice(0, 5) },
    groups: { ...base, kind: 'groups', group: cat[0] || '', outcome: num[0] || cat[1] || '', levels: [] },
    distribution: { ...base, kind: 'distribution', columns: num[0] ? [num[0]] : [] },
  };
}

function Workbench({ projectId, datasetId, ds }: { projectId: string; datasetId: string; ds: DatasetColumns }) {
  const [params] = useSearchParams();
  const x = params.get('x');
  const y = params.get('y');
  const startPair: [string, string] | null = x && y ? [x, y] : null;
  const [tab, setTab] = useState<StatsKind>(() => {
    const t = params.get('tab');
    return TABS.some(([k]) => k === t) ? (t as StatsKind) : 'correlation';
  });
  const [specs, setSpecs] = useState<Specs>(() => defaults(datasetId, ds.columns, startPair));
  const [pair, setPair] = useState<[string, string] | null>(startPair);
  const big = ds.rowCount > AUTO_MAX_ROWS;
  /** What each tab last ran (or is about to): the spec, and a nonce so "Run" re-runs an unchanged spec. */
  const [runs, setRuns] = useState<Partial<Record<StatsKind, { spec: StatsSpec; nonce: number }>>>(() =>
    big ? {} : { [tab]: { spec: specs[tab], nonce: 0 } },
  );
  const spec = specs[tab];
  const ran = runs[tab];
  const stale = !ran || JSON.stringify(ran.spec) !== JSON.stringify(spec);

  // A small table re-runs on its own, 250 ms after the last change.
  useEffect(() => {
    if (big || !stale) return;
    const t = setTimeout(() => setRuns((r) => ({ ...r, [tab]: { spec, nonce: r[tab]?.nonce ?? 0 } })), ran ? 250 : 0);
    return () => clearTimeout(t);
  }, [big, stale, tab, spec, ran]);

  const q = useStatsRun(projectId, ran?.spec ?? null, ran?.nonce ?? 0);
  const reply = q.data;
  const result = reply && reply.ok ? reply.result : null;

  // Compare groups lists the levels its last run found, for its picker.
  const [groups, setGroups] = useState<GroupsResult | null>(null);
  useEffect(() => {
    if (result && result.ok && result.kind === 'groups') setGroups(result);
  }, [result]);

  const client = useQueryClient();
  const change = (patch: Partial<StatsSpec>) => setSpecs((all) => ({ ...all, [tab]: { ...all[tab], ...patch } }));
  const run = () => setRuns((r) => ({ ...r, [tab]: { spec, nonce: (r[tab]?.nonce ?? 0) + 1 } }));
  const model = (target: string, predictor: string) => {
    setSpecs((all) => ({ ...all, regression: { ...all.regression, target, predictors: [predictor] } }));
    setTab('regression');
  };

  async function saveFormula() {
    const res = await call<{ ok: true; name: string; replaced: boolean }>(rpc('stats:saveFormula', { projectId, spec }), 'Could not save the calculated field.');
    if (!res.ok) {
      toast(res.error, { kind: 'error' });
      return;
    }
    toast(`${res.replaced ? 'Updated' : 'Added'} ${res.name} — it is a calculated field in Prepare.`, { kind: 'success' });
    // The new column joins the pickers here and on the dataset page.
    void client.invalidateQueries({ queryKey: ['dataset:columns', projectId, datasetId] });
  }

  const actions = (extra?: ReactNode) => (
    <>
      {extra}
      <AddToDashboard projectId={projectId} spec={ran?.spec ?? spec} />
    </>
  );

  let body: ReactNode;
  if (big && !ran) {
    body = (
      <EmptyState icon="play" title="Ready to run" actions={<Button variant="primary" icon="play" onClick={run}>Run analysis</Button>}>
        {`${formatNumber(ds.rowCount)} rows — large runs go to the background as a job.`}
      </EmptyState>
    );
  } else if (q.isPending || q.isFetching || (!big && stale)) {
    body = (
      <div className={s.loading}>
        <SkeletonBlock label={big ? 'Running as a background job — progress and Cancel are in Jobs.' : 'Computing'} />
        {big && <p className={s.ctlHint}>Running as a background job — progress and Cancel are in Jobs.</p>}
      </div>
    );
  } else if (!reply || !reply.ok) {
    body = <Problem message={reply && !reply.ok ? reply.error : 'Could not run the analysis.'} />;
  } else if (!result || !result.ok) {
    body = <Problem message={result && !result.ok ? result.error : 'Could not run the analysis.'} />;
  } else if (result.kind === 'correlation') {
    body = <CorrelationView r={result} spec={ran!.spec} pair={pair} onPair={setPair} onModel={model} actions={actions()} projectId={projectId} />;
  } else if (result.kind === 'regression') {
    body = (
      <RegressionView
        r={result}
        figures={reply.figures}
        actions={actions(
          <Button size="sm" variant="primary" icon="function" title={`Add predicted_${result.fit.target} to this dataset as a calculated field`} onClick={() => void saveFormula()}>
            {`Save as predicted_${result.fit.target}`}
          </Button>,
        )}
      />
    );
  } else if (result.kind === 'groups') {
    body = <GroupsView r={result} figures={reply.figures} actions={actions()} />;
  } else {
    body = <DistributionView r={result} actions={actions()} />;
  }

  const sub = `${ds.name} · ${formatNumber(ds.rowCount)} rows · every figure computed by the app`;
  return (
    <div className={a.wb}>
      <WorkbenchHead icon="activity" title="Statistics" sub={sub} projectId={projectId} datasetId={datasetId} kind="stats" back={{ to: `/analytics?project=${projectId}`, label: 'Close' }} />
      <div className={a.tabs}>
        <Tabs value={tab} onValueChange={(v) => setTab(v as StatsKind)}>
          <TabList label="Analyses">
            {TABS.map(([k, label]) => (
              <Tab key={k} value={k}>
                {label}
              </Tab>
            ))}
          </TabList>
        </Tabs>
      </div>
      <div className={s.body} role="tabpanel" aria-label={TABS.find(([k]) => k === tab)?.[1]}>
        <StatsControls tab={tab} spec={spec} columns={ds.columns} groups={groups} big={big} onChange={change} onRun={run} />
        <div className={s.results} aria-live="polite">
          {body}
        </div>
      </div>
    </div>
  );
}

export default function StatsPage() {
  return (
    <DatasetRoute title="Statistics">
      {(projectId, datasetId, ds) => <Workbench key={datasetId} projectId={projectId} datasetId={datasetId} ds={ds} />}
    </DatasetRoute>
  );
}

