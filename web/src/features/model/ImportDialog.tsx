// Import… on the Data model (semantic layer part 7, a3; docs/semantic-layer/07-portability.md "What you will see"):
// pick a model zip, read its dry run (`model:importPlan`), pick a side for each conflict, apply (`model:importApply`).
// Or dbt's semantic_manifest.json (f1, D10): each semantic model's dataset is confirmed under Datasets, and a change
// there plans again with `datasetMap`, which the apply sends too.
// The picked File is kept and uploaded again for the apply and for each "Check again": an upload is used once.
// Every count and sentence is the server's; this words the plan (./importPlanText.ts) and nothing more.

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startDownload } from '../../api/files';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { useDatasets } from '../../api/datasets';
import { applyModelImport, importRefresh, notCarriedText, planModelImport, type DatasetMap, type ImportPlan, type PlanStatus } from './api';
import { applyLabel, changesToApply, dbtModels, planSections } from './importPlanText';
import { formatNumber } from '../data/format';
import s from './ImportDialog.module.css';

type Choice = 'file' | 'here';
type Applied = { written: string[]; failed: { key: string; error: string }[]; before?: { downloadToken: string } };
type Step =
  | { at: 'pick' }
  | { at: 'planning'; file: File }
  | { at: 'refused'; file: File; error: string }
  | { at: 'plan'; file: File; plan: ImportPlan; stale?: string; applying?: boolean }
  | { at: 'done'; file: File; plan: ImportPlan; applied: Applied };

const ICON: Record<PlanStatus, IconName> = {
  unchanged: 'check', updated: 'refresh', renamed: 'pencil', new: 'plus', conflict: 'alert', skipped: 'minus', onlyHere: 'circle',
};
const SIDES = [
  { value: 'here', label: 'Keep this project\'s' },
  { value: 'file', label: 'Use the file\'s' },
];

const why = (err: unknown): string => (err instanceof Error && err.message !== 'forbidden' ? err.message : 'You do not have permission to import into this project.');

function Planning() {
  return (
    <div className={s.rows} role="status" aria-busy="true" aria-label="Reading the files">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className={s.row} aria-hidden="true">
          <Skeleton className={s.skIcon} />
          <Skeleton className={s.skTitle} />
          <Skeleton className={s.skLine} />
        </div>
      ))}
    </div>
  );
}

/** A dbt file's semantic models, each with the project's dataset it is (a select), and the copy notice. */
function DbtDatasets({ projectId, plan, onPick, busy }: { projectId: string; plan: ImportPlan; onPick: (model: string, datasetId: string) => void; busy: boolean }) {
  const list = useDatasets(projectId);
  const options = (list.data ?? []).map((d) => ({ value: d.id, label: d.name }));
  return (
    <section className={s.row} data-status="datasets" aria-label="Datasets">
      <span className={s.mark} aria-hidden="true">
        <Icon name="database" size={12} />
      </span>
      <h3 className={s.title}>Datasets</h3>
      <div className={s.body}>
        <p className={s.note}>A copy: dbt stays the source of truth only through a live dbt connection.</p>
        {list.isError && (
          <div className={s.stale} role="alert">
            <Icon name="alert" size={16} />
            <span className={s.staleText}>This project&apos;s datasets could not be loaded, so a semantic model can&apos;t be pointed at one.</span>
            <Button size="sm" icon="refresh" onClick={() => void list.refetch()}>
              Try again
            </Button>
          </div>
        )}
        <ul className={s.lines}>
          {dbtModels(plan).map((m) => (
            <li key={m.key} className={s.line}>
              <span className={s.text}>
                <span className={s.name}>{m.model}</span>
                {(m.loose || !m.datasetId) && <span className={s.detail}>{m.datasetId ? 'matched by name: check it' : 'no dataset here: pick one to import it'}</span>}
              </span>
              <Select
                size="sm"
                aria-label={`Dataset for ${m.model}`}
                className={s.side}
                value={m.datasetId ?? ''}
                placeholder="Not in this project"
                onValueChange={(v) => onPick(m.model, v)}
                options={options}
                disabled={busy || list.isPending}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function PlanRows({ plan, choices, onChoice, busy, datasets }: { plan: ImportPlan; choices: Record<string, Choice>; onChoice: (key: string, c: Choice) => void; busy: boolean; datasets?: ReactNode }) {
  const carried = notCarriedText(plan.notCarried);
  return (
    <div className={s.rows}>
      {datasets}
      {planSections(plan).map((sec) => (
        <section key={sec.status} className={s.row} data-status={sec.status} aria-label={sec.title}>
          <span className={s.mark} aria-hidden="true">
            <Icon name={ICON[sec.status]} size={12} />
          </span>
          <h3 className={s.title}>{sec.title}</h3>
          <div className={s.body}>
            {sec.note && <p className={s.note}>{sec.note}</p>}
            {sec.lines.length > 0 && (
              <ul className={s.lines}>
                {sec.lines.map((l) => (
                  <li key={l.key} className={s.line}>
                    <span className={s.text}>
                      <span className={s.name}>{l.text}</span>
                      {l.detail && <span className={s.detail}>{l.detail}</span>}
                    </span>
                    {sec.status === 'conflict' && (
                      <Select
                        size="sm"
                        aria-label={l.text}
                        className={s.side}
                        value={choices[l.key] ?? 'here'}
                        onValueChange={(v) => onChoice(l.key, v as Choice)}
                        options={SIDES}
                        disabled={busy}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ))}
      {carried && <p className={s.carried}>{carried}</p>}
    </div>
  );
}

function Done({ plan, applied, asked }: { plan: ImportPlan; applied: Applied; asked: number }) {
  const name = (key: string) => plan.items.find((i) => i.key === key)?.name ?? key;
  const n = applied.written.length;
  const all = applied.failed.length === 0;
  const head = all ? `Applied ${formatNumber(n)} ${n === 1 ? 'change' : 'changes'}.` : n === 0 ? 'No changes were applied.' : `Applied ${formatNumber(n)} of ${formatNumber(asked)} changes.`;
  return (
    <div className={s.done} data-tone={all ? 'ok' : 'warn'} role={all ? 'status' : 'alert'}>
      <span className={s.doneIcon} aria-hidden="true">
        <Icon name={all ? 'circle-check' : 'alert'} size={20} />
      </span>
      <div className={s.doneBody}>
        <h3 className={s.doneTitle}>{head}</h3>
        {!all && (
          <>
            <p className={s.note}>{applied.failed.length === 1 ? 'This one was not written:' : 'These were not written:'}</p>
            <ul className={s.lines}>
              {applied.failed.map((f) => (
                <li key={f.key} className={s.line}>
                  <span className={s.text}>
                    <span className={s.name}>{name(f.key)}</span>
                    <span className={s.detail}>{f.error}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {applied.before && (
          <div className={s.before}>
            <p className={s.note}>The model as it was before is a download: importing it puts back what this import changed, except a field whose sensitivity mark it raised: an import never lowers one, so that field stays as it is now. Anything new stays.</p>
            <Button size="sm" icon="download" onClick={() => startDownload((applied.before as { downloadToken: string }).downloadToken)}>
              Download the model as it was before
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ImportDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ at: 'pick' });
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [map, setMap] = useState<DatasetMap>({});
  const picker = useRef<HTMLInputElement>(null);
  const client = useQueryClient();

  const check = async (file: File, datasetMap: DatasetMap = map) => {
    setStep({ at: 'planning', file });
    setChoices({});
    try {
      const r = await planModelImport(projectId, file, datasetMap);
      setStep(r.ok ? { at: 'plan', file, plan: r.plan } : { at: 'refused', file, error: r.error });
    } catch (err) {
      setStep({ at: 'refused', file, error: why(err) });
    }
  };

  const apply = async (file: File, plan: ImportPlan) => {
    setStep({ at: 'plan', file, plan, applying: true });
    try {
      const r = await applyModelImport(projectId, file, plan.hash, choices, map);
      if (!r.ok) {
        setStep({ at: 'plan', file, plan, stale: r.error });
        return;
      }
      setStep({ at: 'done', file, plan, applied: r });
      for (const key of importRefresh(plan, r.written)) void client.invalidateQueries({ queryKey: [key] }); // what it wrote, not every screen
    } catch (err) {
      setStep({ at: 'plan', file, plan, stale: why(err) });
    }
  };

  const chosen = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      setMap({});
      void check(file, {});
    }
  };
  const pickDataset = (file: File, model: string, datasetId: string) => {
    const next = { ...map, [model]: datasetId };
    setMap(next);
    void check(file, next);
  };
  const choose = (
    <Button variant={step.at === 'pick' ? 'primary' : 'ghost'} size={step.at === 'pick' ? 'md' : 'sm'} icon="upload" onClick={() => picker.current?.click()}>
      {step.at === 'pick' ? 'Choose a file…' : 'Choose another file'}
    </Button>
  );

  let body: ReactNode;
  let footer: ReactNode;
  const cancel = (
    <DialogClose asChild>
      <Button disabled={step.at === 'plan' && step.applying}>{step.at === 'done' ? 'Close' : 'Cancel'}</Button>
    </DialogClose>
  );
  if (step.at === 'pick') {
    body = (
      <EmptyState icon="upload" title="Choose model files" heading={3} actions={choose}>
        A .zip of model files exported from a Data model, or dbt's target/semantic_manifest.json. You see everything it would change before anything is written.
      </EmptyState>
    );
    footer = cancel;
  } else if (step.at === 'planning') {
    body = <Planning />;
    footer = cancel;
  } else if (step.at === 'refused') {
    body = <ErrorState title="These files can't be imported" message={step.error} onRetry={() => void check(step.file)} heading={3} />;
    footer = cancel;
  } else if (step.at === 'plan') {
    const n = changesToApply(step.plan, choices);
    const { file, plan } = step;
    body = (
      <>
        {step.stale && (
          <div className={s.stale} role="alert">
            <Icon name="alert" size={16} />
            <span className={s.staleText}>{step.stale}</span>
            <Button size="sm" icon="refresh" onClick={() => void check(file)}>
              Check again
            </Button>
          </div>
        )}
        <PlanRows
          plan={plan}
          choices={choices}
          onChoice={(key, c) => setChoices((prev) => ({ ...prev, [key]: c }))}
          busy={!!step.applying}
          datasets={plan.source.kind === 'dbt' && <DbtDatasets projectId={projectId} plan={plan} onPick={(model, id) => pickDataset(file, model, id)} busy={!!step.applying} />}
        />
      </>
    );
    footer = (
      <>
        {cancel}
        <Button variant="primary" disabled={n === 0 || !!step.stale} loading={step.applying} onClick={() => void apply(file, plan)}>
          {step.applying ? 'Applying…' : applyLabel(n)}
        </Button>
      </>
    );
  } else {
    const { file, plan, applied } = step;
    body = <Done plan={plan} applied={applied} asked={applied.written.length + applied.failed.length} />;
    footer = (
      <>
        {applied.failed.length > 0 && (
          <Button icon="refresh" onClick={() => void check(file)}>
            Check again
          </Button>
        )}
        <DialogClose asChild>
          <Button variant="primary">Close</Button>
        </DialogClose>
      </>
    );
  }

  const busy = step.at === 'planning' || (step.at === 'plan' && !!step.applying);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !(step.at === 'plan' && step.applying) && onClose()}
      title="Import model files"
      description="A dry run first: nothing is written until you apply it."
      size="lg"
      footer={footer}
    >
      <input ref={picker} type="file" accept=".zip,application/zip,.json,application/json" aria-label="Model files" hidden onChange={chosen} />
      {step.at !== 'pick' && (
        <div className={s.fileBar}>
          <span className={s.file}>
            <Icon name="file-text" size={12} />
            <span className={s.fileName}>{step.file.name}</span>
            {(step.at === 'plan' || step.at === 'done') && step.plan.source.project && <span className={s.fileFrom}>exported from "{step.plan.source.project}"</span>}
          </span>
          {step.at !== 'done' && !busy && choose}
        </div>
      )}
      {body}
    </Dialog>
  );
}
