// The create-dashboard wizard (legacy anNew.ts): choose the data, choose what
// to start from — a template mapped to the columns, a plain layout, or the
// Assistant — then map the template's columns or describe the dashboard.
// Step 3 belongs to the template and AI routes only; the three layouts finish
// at step 2. With no model, the AI card is disabled and says why; everything
// else still works.

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { useDatasets } from '../../api/datasets';
import { shortTime } from '../../app/when';
import { Button, buttonClass } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input, Textarea } from '../../ui/Field';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { useKeyStatus } from '../assistant/api';
import { failure, type Analysis, type BuildReply, type DraftReply, type PlanPreview, type Sheet, type TemplateList } from './api';
import { DraftFlow } from './DraftReview';
import { MapColumns, TemplateGallery } from './TemplateStep';
import s from './Wizard.module.css';

type Start = 'blank' | 'kpis' | 'twoup' | 'ai' | 'template';

const STARTS: { id: Start; title: string; body: string; art: string[] }[] = [
  { id: 'blank', title: 'Blank sheet', body: 'One empty sheet. Add cards as you go.', art: ['full'] },
  { id: 'kpis', title: 'KPIs + chart', body: 'A KPI strip across the top, with a wide chart beneath it.', art: ['strip', 'wide'] },
  { id: 'twoup', title: 'Two-up', body: 'Two charts side by side, with a notes card below.', art: ['half', 'half', 'strip'] },
  { id: 'ai', title: 'Let the Assistant design it', body: 'Describe what you want and a model proposes the sheets. You review it first.', art: ['ai'] },
];

const EXAMPLES = [
  'Show revenue by region over time, and flag any concentration risk.',
  'Which categories are growing fastest, and which are shrinking?',
  'Give me an overview sheet, then a sheet per region.',
];

const fmtCount = new Intl.NumberFormat();

export function NewWizard({ projectId, datasetId: preset, onClose }: { projectId: string; datasetId?: string; onClose: () => void }) {
  const sets = useDatasets(projectId);
  const key = useKeyStatus();
  const aiReady = !!key.data?.isReady;
  const navigate = useNavigate();
  const client = useQueryClient();

  const list = useMemo(() => sets.data ?? [], [sets.data]);
  const initial = list.find((d) => d.id === preset) ?? (list.length === 1 ? list[0] : undefined);
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId = picked ?? initial?.id ?? null;
  const selected = list.find((d) => d.id === selectedId);
  const [step, setStep] = useState(1);
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [start, setStart] = useState<Start>('blank');
  const [tpl, setTpl] = useState('');
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<PlanPreview | null>(null);

  // Tracks the dataset until the user types their own name.
  const shownName = nameTouched ? name : selected ? `${selected.name.trim()} dashboard` : '';
  const chosenName = shownName.trim() || 'Untitled dashboard';

  // The catalogue is a fact about the DATASET: one call per dataset, cached by the query.
  const templates = useQuery({
    queryKey: ['template:list', projectId, selectedId],
    enabled: step >= 2 && !!selectedId,
    queryFn: async () => (await rpc('template:list', { projectId, datasetId: selectedId as string })) as TemplateList,
  });
  // r7:templates "Yours" need utpl:* (not on the server yet), so only the built-in subjects are offered.
  const subjects = templates.data && templates.data.ok ? templates.data.templates.filter((t) => t.group === 'Templates') : [];
  const template = subjects.find((t) => t.id === tpl);
  const onTemplate = start === 'template' && !!template;
  const hasStep3 = start === 'ai' || onTemplate;

  const pickDataset = (id: string) => {
    if (id !== selectedId) {
      setTpl('');
      if (start === 'template') setStart('blank');
    }
    setPicked(id);
  };

  const opened = (a: { id: string }) => {
    void client.invalidateQueries({ queryKey: ['analysis:gallery', projectId] });
    onClose();
    void navigate(`/analyses/${projectId}/${a.id}`);
  };

  // A plain layout: create it, then (KPIs / Two-up) lay the starter's cards on its sheet.
  const createFrom = async (kind: Start) => {
    setBusy(true);
    try {
      const made = (await rpc('analysis:create', { projectId, name: chosenName })) as Analysis | { ok: false; error: string };
      if ('ok' in made && made.ok === false) throw new Error(made.error);
      const a = made as Analysis;
      if ((kind === 'kpis' || kind === 'twoup') && selectedId) {
        const st = (await rpc('analysis:starterCards', { projectId, kind, datasetId: selectedId })) as { ok: boolean; cards?: Sheet['cards']; error?: string };
        if (!st.ok) toast(failure(st, 'The starter layout could not be built.'), { kind: 'error' });
        else if (st.cards && st.cards.length) {
          const sheet = a.sheets[0];
          await rpc('analysis:update', { projectId, id: a.id, sheets: [{ ...sheet, cards: st.cards }] });
        }
      }
      opened(a);
    } catch (err) {
      toast(failure(err, 'Failed to create the dashboard.'), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // A template: the plan the mapping step previewed, built through the same `analysis:buildPlan` the Assistant's plans use.
  const createFromTemplate = async () => {
    if (!plan) return toast('That mapping could not be built. Change a column and try again.', { kind: 'error' });
    setBusy(true);
    try {
      const r = (await rpc('analysis:buildPlan', { projectId, plan: { ...plan, name: chosenName } })) as BuildReply;
      if (!r.ok) throw new Error(r.error);
      opened(r.analysis);
    } catch (err) {
      toast(failure(err, 'Failed to create the dashboard.'), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // The AI route: the wizard stays busy while the model works, then the review takes over.
  const runDraft = async () => {
    setBusy(true);
    let r: DraftReply;
    try {
      r = (await rpc('analysis:draft', { projectId, ...(selectedId ? { datasetId: selectedId } : {}), ...(intent.trim() ? { intent: intent.trim() } : {}) })) as DraftReply;
    } catch (err) {
      r = { ok: false, error: failure(err, 'Could not draft a dashboard.') };
    }
    setBusy(false);
    if (!r.ok && r.notReady) {
      // The model went away since the wizard opened: back to the step that still builds one.
      void key.refetch();
      setStart('blank');
      setStep(2);
      return;
    }
    if (!r.ok) return toast(r.error || 'Could not draft a dashboard.', { kind: 'error' });
    setDraft(r);
  };

  const next = async () => {
    if (step === 1) return setStep(2);
    if (step === 2) {
      if (hasStep3) return setStep(3);
      return createFrom(start);
    }
    if (onTemplate) return createFromTemplate();
    return runDraft();
  };

  if (draft) return <DraftFlow projectId={projectId} draft={draft} preferredName={nameTouched ? chosenName : ''} onClose={onClose} />;

  const sub =
    step === 1
      ? 'Choose the dataset to build from. You can add more sheets and datasets later.'
      : step === 2
        ? 'Start from a template built for your data, a plain layout, or let a model design it.'
        : onTemplate
          ? 'Check which column plays which part. Every figure below is computed from your data.'
          : 'Describe the dashboard and the Assistant will draft it. You review everything before it is created.';
  const nextLabel =
    step === 1 ? 'Next' : step === 2 ? (hasStep3 ? 'Next' : 'Create dashboard') : onTemplate ? 'Create dashboard' : busy ? 'Thinking…' : 'Draft with the Assistant';

  const rail = [
    { n: 1, label: 'Choose data' },
    { n: 2, label: 'Start from' },
    { n: 3, label: onTemplate ? 'Map columns' : 'Describe it', optional: !onTemplate },
  ];
  const q = search.trim().toLowerCase();
  const shown = list.filter((d) => !q || d.name.toLowerCase().includes(q));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Create dashboard"
      description={sub}
      footer={
        <>
          {step > 1 && (
            <Button variant="ghost" icon="chevron-left" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </Button>
          )}
          <span className={s.spacer} />
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          {step === 3 && !onTemplate && (
            <Button onClick={() => void createFrom('blank')} disabled={busy}>
              Skip — blank sheet
            </Button>
          )}
          <Button variant="primary" onClick={() => void next()} loading={busy} disabled={step === 1 && !selectedId}>
            {nextLabel}
          </Button>
        </>
      }
    >
      <ol className={s.rail} aria-label="Steps">
        {rail.map((r) => {
          const skipped = r.n === 3 && !hasStep3;
          const cls = [s.step, r.n === step && s.active, r.n < step && s.done, skipped && s.skipped].filter(Boolean).join(' ');
          return (
            <li key={r.n} className={cls} aria-current={r.n === step ? 'step' : undefined}>
              <span className={s.dot}>{r.n < step ? <Icon name="check" size={12} /> : r.n}</span>
              <span>{r.label}</span>
              {r.optional && <span className={s.optional}>Optional</span>}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div className={s.pane}>
          <div className={s.bar}>
            <Input icon="search" type="search" placeholder="Search datasets by name" aria-label="Search datasets by name" value={search} onChange={(e) => setSearch(e.target.value)} />
            {/* One import path: leave the wizard for the ordinary one. */}
            <Link className={buttonClass('secondary')} to={`/data/import?project=${projectId}`} onClick={onClose}>
              Create dataset
            </Link>
          </div>
          {sets.isPending ? (
            <SkeletonRows rows={4} label="Loading datasets" />
          ) : list.length === 0 ? (
            <p className={s.none}>This project has no datasets yet. Create one first — a dashboard is built on data.</p>
          ) : (
            <>
              <div className={s.table} role="radiogroup" aria-label="Dataset">
                <div className={s.cols} aria-hidden="true">
                  <span />
                  <span>Dataset name</span>
                  <span>Rows</span>
                  <span>Columns</span>
                  <span>Source</span>
                  <span>Last modified</span>
                </div>
                {shown.length === 0 && <p className={s.none}>No dataset matches “{search.trim()}”.</p>}
                {shown.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="radio"
                    aria-checked={d.id === selectedId}
                    className={d.id === selectedId ? `${s.row} ${s.selected}` : s.row}
                    onClick={() => pickDataset(d.id)}
                  >
                    <span className={s.radio} aria-hidden="true" />
                    <span className={s.dsName}>{d.name || 'Untitled'}</span>
                    <span className={s.cell}>{fmtCount.format(d.rowCount)}</span>
                    <span className={s.cell}>{d.columnCount}</span>
                    <span className={s.cell}>
                      <span className={s.kind}>{d.sourceKind || 'csv'}</span>
                    </span>
                    <span className={s.cell}>{shortTime(d.updatedAt)}</span>
                  </button>
                ))}
              </div>
              <Input
                label="Dashboard name"
                placeholder="Untitled dashboard"
                value={shownName}
                maxLength={200}
                onChange={(e) => {
                  setNameTouched(true);
                  setName(e.target.value);
                }}
              />
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div className={s.pane}>
          <div className={s.groupH}>
            <span>Templates</span>
            <span className={s.groupP}>A complete dashboard, mapped to your columns.</span>
          </div>
          {templates.isPending ? (
            <p className={s.none}>Reading your columns…</p>
          ) : templates.data && !templates.data.ok ? (
            <p className={s.none}>{templates.data.error || 'Templates are unavailable for this dataset.'}</p>
          ) : templates.isError ? (
            <p className={s.none}>Templates are unavailable for this dataset.</p>
          ) : (
            <TemplateGallery
              templates={subjects}
              picked={start === 'template' ? tpl : ''}
              onPick={(id) => {
                setTpl(id);
                setPlan(null);
                setStart('template');
              }}
            />
          )}
          <div className={s.groupH}>
            <span>Layouts</span>
            <span className={s.groupP}>A scaffold to fill in yourself.</span>
          </div>
          <div className={s.starts} role="radiogroup" aria-label="Layouts">
            {STARTS.map((o) => {
              const on = o.id === start;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={o.id === 'ai' && !aiReady}
                  className={[s.start, on && s.selected, o.id === 'ai' && s.startAi].filter(Boolean).join(' ')}
                  onClick={() => {
                    setStart(o.id);
                    setTpl('');
                  }}
                >
                  <span className={s.art} aria-hidden="true">
                    {o.art.map((a, i) => (
                      <span key={i} className={`${s.block} ${s[`b_${a}`]}`} />
                    ))}
                  </span>
                  <span className={s.startT}>
                    {o.id === 'ai' && <Icon name="sparkles" />}
                    {o.title}
                  </span>
                  <span className={s.startP}>{o.body}</span>
                </button>
              );
            })}
          </div>
          {!aiReady && key.isSuccess && (
            <p className={s.note}>No model is connected. Drafting is unavailable, but everything else works without one — pick any of the other three.</p>
          )}
        </div>
      )}

      {step === 3 && onTemplate && template && selectedId && templates.data?.ok && (
        <MapColumns
          key={template.id}
          projectId={projectId}
          datasetId={selectedId}
          template={template}
          columns={templates.data.columns}
          name={chosenName}
          onPlan={setPlan}
        />
      )}
      {step === 3 && !onTemplate && (
        <div className={s.ai}>
          <h3 className={s.aiH}>
            <Icon name="sparkles" />
            Describe what you want to see
          </h3>
          <p className={s.aiP}>
            The model proposes structure only — which sheets, which charts, which calculated fields. Every number is computed by the app from your data,
            and you review the whole draft before anything is created.
          </p>
          <Textarea
            aria-label="Describe the dashboard"
            rows={4}
            autoFocus
            placeholder="e.g. Revenue by region over the last year, with a sheet breaking down the top region."
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            maxLength={2000}
          />
          <div className={s.chips}>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className={s.chip} onClick={() => setIntent(ex)}>
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}
