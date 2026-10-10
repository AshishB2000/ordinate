// "+ New visual" (vizNew.ts): which dataset, then how — describe it to the
// Assistant or open the builder yourself. When the model proposes charts they
// are DRAWN, so you pick from real charts: the model contributed an encoding,
// a type and a caption, and every figure comes from `visual:data`. Which type
// is drawn is CODE's call — a proposed type the data cannot draw falls back to
// the first eligible one. The dialog only RESOLVES a choice; it never saves.
//
// The builder's "Suggest chart" opens this same dialog straight at step 3.

import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useDatasets } from '../../api/datasets';
import { loadVizData } from '../../api/visuals';
import { Chart } from '../../charts/Chart';
import { DataTable } from '../../charts/DataTable';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Textarea } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Skeleton, SkeletonBlock, SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { useAiStatus } from '../assistant/api';
import { AiNotReady } from '../assistant/AiNotReady';
import { suggestCharts, type Encoding, type SuggestReply, type Suggestion } from './api';
import { countNumericSeries, eligibleChartTypes } from './eligibility';
import { typeLabel } from './model';
import s from './NewVisual.module.css';

export type NewChoice =
  | { kind: 'manual'; datasetId: string }
  | { kind: 'suggested'; datasetId: string; encoding: Encoding; chartType: string };

const rowsFmt = new Intl.NumberFormat();

export function NewVisualDialog({
  projectId,
  datasetId,
  startAtSuggest,
  aiOnly,
  onClose,
  onChoose,
}: {
  projectId: string;
  datasetId?: string;
  /** Open at step 3 and ask at once (the builder's Suggest chart, the empty state's AI door). */
  startAtSuggest?: boolean;
  aiOnly?: boolean;
  onClose: () => void;
  onChoose: (c: NewChoice) => void;
}) {
  const navigate = useNavigate();
  const sets = useDatasets(projectId);
  const ai = useAiStatus();
  const aiReady = !!ai.data?.ready;
  const [selected, setSelected] = useState(datasetId ?? '');
  const [step, setStep] = useState<1 | 2 | 3>(startAtSuggest && datasetId ? 3 : datasetId ? 2 : 1);
  const [intent, setIntent] = useState('');
  // Each ask (and Regenerate) is a new query; the builder's door has asked on open.
  const [asked, setAsked] = useState(startAtSuggest && datasetId ? 1 : 0);
  const intentRef = useRef(intent);

  const ask = (id = selected) => {
    if (!id) return;
    intentRef.current = intent.trim();
    setAsked((n) => n + 1);
    setStep(3);
  };

  const pick = (id: string) => {
    setSelected(id);
    // "Start with the Assistant" came here with no dataset: this choice IS the missing input.
    if (startAtSuggest) ask(id);
    else setStep(2);
  };
  const manual = () => selected && onChoose({ kind: 'manual', datasetId: selected });
  const canBack = step === 3 || (step === 2 && !startAtSuggest && !datasetId);

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="New visual"
      footer={
        <>
          {canBack && (
            <Button icon="arrow-left" onClick={() => setStep(step === 3 ? 2 : 1)}>
              Back
            </Button>
          )}
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
        </>
      }
    >
      {step === 1 &&
        (sets.isPending ? (
          <SkeletonRows rows={4} label="Loading datasets" />
        ) : sets.isError ? (
          <ErrorState compact heading={3} title="Datasets could not be loaded" message={sets.error.message} onRetry={() => void sets.refetch()} />
        ) : sets.data.length === 0 ? (
          <div className={s.none}>
            <p className={s.sub}>No datasets yet. A visual reads one, so bring some data in first.</p>
            <Button variant="primary" onClick={() => void navigate('/data')}>
              Import data
            </Button>
          </div>
        ) : (
          <div className={s.pane}>
            <p className={s.sub}>Pick the dataset this visual reads from.</p>
            <div className={s.rows} role="radiogroup" aria-label="Dataset">
              {sets.data.map((d) => (
                <button key={d.id} type="button" role="radio" aria-checked={d.id === selected} className={s.row} onClick={() => pick(d.id)}>
                  <span className={s.rowName}>{d.name || 'Untitled dataset'}</span>
                  <span className={s.rowMeta}>
                    {rowsFmt.format(d.rowCount)} rows × {rowsFmt.format(d.columnCount)} columns
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}

      {step === 2 && (
        <div className={s.choices}>
          <div className={aiReady ? s.choice : `${s.choice} ${s.disabled}`}>
            <h3 className={s.choiceH}>Describe it</h3>
            <p className={s.sub}>Say what you want to see and a model proposes charts. You pick one — nothing is saved for you.</p>
            <Textarea
              aria-label="Describe the visual you want"
              placeholder="e.g. profile registrations year over year"
              rows={3}
              value={intent}
              disabled={!aiReady}
              autoFocus={aiReady}
              onChange={(e) => setIntent(e.target.value)}
            />
            {ai.data && !aiReady && <AiNotReady status={ai.data} className={s.note} />}
            <Button variant="primary" icon="sparkles" disabled={!aiReady} onClick={() => ask()}>
              Ask the Assistant
            </Button>
          </div>
          {!aiOnly && (
            <div className={s.choice}>
              <h3 className={s.choiceH}>Build it myself</h3>
              <p className={s.sub}>Open the builder on a blank chart and choose the category, measures and type yourself.</p>
              <Button autoFocus={!aiReady} onClick={manual}>
                Open the builder
              </Button>
            </div>
          )}
        </div>
      )}

      {step === 3 && <Proposals projectId={projectId} datasetId={selected} intent={intentRef.current} asked={asked} onUse={onChoose} onManual={manual} onRegenerate={() => ask()} />}
    </Dialog>
  );
}

function Proposals({ projectId, datasetId, intent, asked, onUse, onManual, onRegenerate }: {
  projectId: string;
  datasetId: string;
  intent: string;
  asked: number;
  onUse: (c: NewChoice) => void;
  onManual: () => void;
  onRegenerate: () => void;
}) {
  const ai = useAiStatus();
  const q = useQuery({
    queryKey: ['visual:suggest', projectId, datasetId, intent, asked],
    queryFn: (): Promise<SuggestReply> => suggestCharts(projectId, datasetId, intent),
    enabled: asked > 0,
    staleTime: Infinity,
    retry: false,
  });
  const r = q.data;
  const options = r && r.ok ? r.options : [];
  return (
    <div className={s.pane}>
      <p className={s.sub} role="status">
        {q.isPending
          ? 'Thinking…'
          : q.isError
            ? q.error.message
            : r && !r.ok
              ? r.notReady
                ? ''
                : r.error || 'Could not suggest a chart.'
              : options.length
                ? 'Pick one to open it in the builder. Nothing is saved until you save it.'
                : 'Could not suggest a chart.'}
      </p>
      {r && !r.ok && r.notReady && <AiNotReady status={ai.data} className={s.note} />}
      {q.isPending ? (
        <div className={s.options} role="status" aria-busy="true" aria-label="Asking for charts">
          {[0, 1, 2].map((i) => (
            <div key={i} className={s.option} aria-hidden="true">
              <Skeleton className={s.artSkel} />
              <Skeleton className={s.whySkel} />
            </div>
          ))}
        </div>
      ) : (
        <div className={s.options}>
          {options.map((o, i) => (
            <Option key={i} projectId={projectId} datasetId={datasetId} option={o} onUse={onUse} />
          ))}
        </div>
      )}
      <div className={s.actions}>
        <Button disabled={q.isFetching} onClick={onRegenerate}>
          Regenerate
        </Button>
        <Button variant="ghost" onClick={onManual}>
          Build it myself instead
        </Button>
      </div>
    </div>
  );
}

/** One proposal, drawn from app-computed data; unpickable until it provably draws. */
function Option({ projectId, datasetId, option, onUse }: { projectId: string; datasetId: string; option: Suggestion; onUse: (c: NewChoice) => void }) {
  const q = useQuery({
    queryKey: ['visual:data', projectId, datasetId, option.encoding],
    queryFn: () => loadVizData({ projectId, datasetId, encoding: option.encoding as Parameters<typeof loadVizData>[0]['encoding'] }),
    retry: false,
  });
  const res = q.data && q.data.ok ? q.data : null;
  const data = res?.data;
  const drawable = !!data && Array.isArray(data.labels) && data.labels.length > 0;
  const eligible = res && data ? eligibleChartTypes(res.recommendedShape, countNumericSeries(data), (data.labels || []).length) : [];
  const type = eligible.includes(option.chartType) ? option.chartType : eligible[0] || 'table';
  return (
    <div className={drawable || q.isPending ? s.option : `${s.option} ${s.broken}`}>
      <div className={s.art}>
        {q.isPending ? (
          <SkeletonBlock label="Drawing the suggestion" />
        ) : !drawable ? (
          <span className={s.optionNote}>
            <Icon name="alert" /> Couldn’t draw this one
          </span>
        ) : type === 'table' ? (
          <DataTable data={data} label={option.why || 'Suggested table'} />
        ) : (
          <Chart type={type} data={data} label={option.why || `Suggested ${typeLabel(type)}`} />
        )}
      </div>
      <p className={s.why}>{option.why || 'Suggested chart'}</p>
      <Button size="sm" disabled={!drawable} onClick={() => onUse({ kind: 'suggested', datasetId, encoding: option.encoding, chartType: type })}>
        Use this chart
      </Button>
    </div>
  );
}
