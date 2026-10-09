// /data/:projectId/:datasetId/prepare — the reversible pipeline over a saved
// dataset (legacy prepare.ts + the explorer's Prepare tab): the step rail beside
// the dataset's own rows, which ARE the live preview of the prepared output.
// The immutable source and the ordered steps live on the server; every edit
// sends one RPC that recomputes from the source and answers with the new shape,
// and the grid re-pages the stored table. Nothing here computes a figure.
//
// `?add=<step type>&column=<name>` opens the editor for a new step, prefilled —
// the hook the dataset page's column profile uses ("Mask…", the text steps).

import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { formatNumber } from '../../../../src/app/format.ts';
import { datasetPageSource, useDatasets } from '../../api/datasets';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Button, buttonClass } from '../../ui/Button';
import { DataGrid } from '../../ui/DataGrid/DataGrid';
import { Drawer } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import { Splitter, useStoredSize } from '../../ui/Splitter';
import { toast } from '../../ui/Toast';
import { mutate, useApplyReply, usePrepare, type Mutation, type PrepareState, type Step } from './api';
import type { Draft } from './drafts';
import type { FormCtx } from './FormParts';
import { FormulaEditor } from './FormulaEditor';
import { StepEditor } from './StepEditor';
import { StepList } from './StepList';
import { STEP_TYPES, TEXT_STEPS } from './steps';
import { SuggestedSteps, useSuggestCalc, useSuggestSteps } from './Suggest';
import { TextProfile } from './TextProfile';
import { useAdoptProject } from '../projects/current';
import { LiveOffPage, useIsLive } from '../live/LiveOff';
import s from './Prepare.module.css';

export default function PreparePage() {
  const { projectId, datasetId } = useParams();
  useAdoptProject(projectId); // the URL names the project: the switcher follows it
  // A Live dataset keeps no rows to prepare (L2.6): say so, and offer a copy — before asking prepare:get, which would refuse.
  const live = useIsLive(projectId, datasetId);
  if (live.pending) return <PageSkeleton />;
  if (live.live && projectId && datasetId) return <LiveOffPage title="Prepare" projectId={projectId} datasetId={datasetId} feature="prepare" />;
  return <PrepareRoute projectId={projectId} datasetId={datasetId} />;
}

function PrepareRoute({ projectId, datasetId }: { projectId: string | undefined; datasetId: string | undefined }) {
  const q = usePrepare(projectId, datasetId);
  if (q.isPending || !projectId || !datasetId) return <PageSkeleton />;
  if (q.isError) {
    return (
      <Page title="Prepare">
        <ErrorState title="This dataset could not be opened" message={q.error.message} onRetry={() => void q.refetch()} />
      </Page>
    );
  }
  if (!q.data) {
    return (
      <Page title="Prepare">
        <EmptyState icon="database" title="Dataset not found">
          It may have been deleted, or moved to the Trash with its project.
        </EmptyState>
      </Page>
    );
  }
  return <Prepare projectId={projectId} datasetId={datasetId} state={q.data} />;
}

type Editing = { type: string; index: number; prefill?: Draft } | null;
type Formula = { index: number; prefill?: { name: string; expression: string; note?: string } } | null;

function Prepare({ projectId, datasetId, state }: { projectId: string; datasetId: string; state: PrepareState }) {
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Editing>(() => {
    const add = params.get('add');
    return add && STEP_TYPES.some((t) => t.type === add) && add !== 'calculated_field'
      ? { type: add, index: -1, prefill: { column: params.get('column') ?? '' } }
      : null;
  });
  const [formula, setFormula] = useState<Formula>(() => (params.get('add') === 'calculated_field' ? { index: -1 } : null));
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<string | null>(null);
  const [rail, setRail, commitRail] = useStoredSize('ordinate.prepareRail', 380, 300, 640);
  const apply = useApplyReply(projectId, datasetId);
  const list = useDatasets(projectId);
  const names = useMemo(() => new Map((list.data ?? []).map((d) => [d.id, d.name])), [list.data]);
  // After every edit the grid is keyed anew (state.updatedAt), so it drops what it paged and reads the new table.
  const source = useMemo(() => datasetPageSource(projectId, datasetId), [projectId, datasetId]);
  const suggest = useSuggestSteps(projectId, datasetId);
  const calc = useSuggestCalc(projectId, datasetId, (prefill) => setFormula({ index: -1, prefill }));

  /** Sends one edit; null when it landed, else the server's message. */
  async function run(m: Mutation): Promise<string | null> {
    setBusy(true);
    const r = await mutate(projectId, datasetId, m).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'Failed to update the pipeline.' }));
    setBusy(false);
    if (!r.ok) return r.error || 'Failed to update the pipeline.';
    apply(r);
    setWarnings(r.preview.warnings ?? []);
    return null;
  }
  const runOrToast = async (m: Mutation) => {
    const err = await run(m);
    if (err) toast(err, { kind: 'error' });
  };

  function open(type: string, index: number, prefill?: Draft) {
    if (params.has('add')) setParams({}, { replace: true });
    if (type === 'calculated_field') {
      const st = index >= 0 ? state.steps[index] : null;
      setEditing(null);
      setFormula({ index, prefill: st ? { name: String(st.name ?? ''), expression: String(st.expression ?? '') } : undefined });
      return;
    }
    setEditing({ type, index, prefill });
  }

  async function save(steps: Step[]): Promise<string | null> {
    if (!editing) return null;
    const [first, ...rest] = steps;
    const idx = editing.index;
    let err: string | null;
    if (TEXT_STEPS.has(first.type)) err = await run({ kind: 'text', index: idx, step: first });
    else if (first.type === 'spatial_join') err = await run({ kind: 'spatial', index: idx, step: first });
    else err = await run(idx >= 0 ? { kind: 'update', index: idx, step: first } : { kind: 'add', step: first });
    // The extra bound of a range is appended: a filter is a pure row predicate, so its place cannot change the rows.
    for (const extra of rest) if (!err) err = await run({ kind: 'add', step: extra });
    if (!err) setEditing(null);
    return err;
  }

  function move(i: number, dir: -1 | 1) {
    const order = state.steps.map((_, k) => k);
    [order[i], order[i + dir]] = [order[i + dir], order[i]];
    void runOrToast({ kind: 'reorder', order });
  }

  const ctx: FormCtx = { projectId, datasetId, index: editing?.index ?? -1, columns: state.columns, names, openProfile: setProfile };
  const rows = state.rowCount === 1 ? '1 row' : `${formatNumber(state.rowCount)} rows`;
  const cols = state.columns.length === 1 ? '1 column' : `${state.columns.length} columns`;
  const editingStep = editing && editing.index >= 0 ? state.steps[editing.index] : null;

  return (
    <Page title={state.name} sub={`Prepare · ${rows} · ${cols}`}>
      <nav className={s.crumbs} aria-label="Dataset">
        <Link className={buttonClass('ghost', 'sm')} to={`/data/${projectId}/${datasetId}`}>
          <Icon name="arrow-left" />
          <span>Dataset</span>
        </Link>
        <Link className={buttonClass('ghost', 'sm')} to={`/pipelines/${projectId}`}>
          <Icon name="lineage" />
          <span>Pipelines</span>
        </Link>
      </nav>
      <div className={s.layout}>
        <aside className={s.rail} aria-label="Prepare steps" style={{ width: rail }}>
          {warnings.length > 0 && (
            <div className={s.warnings} role="status">
              {warnings.map((w) => (
                <p key={w} className={s.warning}>
                  <Icon name="alert" size={12} />
                  {w}
                </p>
              ))}
            </div>
          )}
          <StepList
            steps={state.steps}
            counts={state.stepCounts}
            names={names}
            busy={busy}
            onMove={move}
            onEdit={(i) => open(state.steps[i].type, i)}
            onRemove={(i) => void runOrToast({ kind: 'remove', index: i })}
          />
          <div className={s.controls}>
            {/* Beside the rail, not under it: the 25 types fit the window's height there (Radix shifts it up to fit). */}
            <Menu
              side="right"
              label="Step types"
              trigger={
                <Button icon="plus" iconEnd="chevron-down" disabled={busy}>
                  Add step
                </Button>
              }
              items={STEP_TYPES.map((t) => ({ label: t.label, onSelect: () => open(t.type, -1) }))}
            />
            <Button icon="sparkles" loading={suggest.state.kind === 'busy'} onClick={() => void suggest.ask()}>
              Suggest steps
            </Button>
            <Button icon="function" loading={calc.busy} onClick={() => void calc.ask()}>
              Suggest calculated field
            </Button>
          </div>
          {calc.hint && (
            <div className={s.suggest} role="status">
              <p className={s.aiHead}>Assistant suggestion — the app compiles and computes the formula</p>
              <p className={s.muted}>{calc.hint}</p>
            </div>
          )}
          {editing && (
            <StepEditor
              key={`${editing.type}:${editing.index}`}
              type={editing.type}
              index={editing.index}
              existing={editingStep}
              prefill={editing.prefill}
              ctx={ctx}
              onSave={save}
              onCancel={() => setEditing(null)}
            />
          )}
          <SuggestedSteps
            state={suggest.state}
            names={names}
            onDismiss={suggest.dismiss}
            onApply={(steps) =>
              void run({ kind: 'set', steps }).then((err) => (err ? toast(err, { kind: 'error' }) : suggest.dismiss()))
            }
          />
        </aside>
        <Splitter size={rail} min={300} max={640} label="Resize the steps panel" onSizeChange={setRail} onCommit={commitRail} />
        <div className={s.gridPane} aria-busy={busy || undefined}>
          <DataGrid
            key={state.updatedAt}
            columns={state.columns}
            source={source}
            label={`${state.name} — prepared rows`}
            emptyTitle="No rows left"
            emptyBody="The steps above filter every row out. Edit or remove one to bring rows back."
          />
        </div>
      </div>

      {formula && (
        <FormulaEditor
          projectId={projectId}
          datasetId={datasetId}
          columns={state.columns}
          existing={formula.prefill}
          onClose={() => setFormula(null)}
          onSave={(f) => {
            const step: Step = { type: 'calculated_field', name: f.name, expression: f.expression };
            return run(formula.index >= 0 ? { kind: 'update', index: formula.index, step } : { kind: 'add', step });
          }}
        />
      )}
      <Drawer open={profile !== null} onOpenChange={(o) => !o && setProfile(null)} title={profile ? `Text · ${profile}` : 'Text'} description="Over the first 5,000 filled values, read on the server.">
        {profile && (
          <TextProfile
            projectId={projectId}
            datasetId={datasetId}
            column={profile}
            onOpenStep={(type, prefill) => {
              setProfile(null);
              open(type, -1, prefill);
            }}
          />
        )}
      </Drawer>
    </Page>
  );
}
