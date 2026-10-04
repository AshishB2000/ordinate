// The pickers behind the block picker (storyPickers.ts): a saved visual, one
// metric or a row of up to four, an image from this computer, and a filter
// pinned to one chart block. Each ends in a value handed back; nothing here
// saves anything (the page's autosave does, through storyModel's whitelist).

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { useDatasetColumns } from '../../../api/datasets';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { Icon } from '../../../ui/icons/Icon';
import { vizLabel } from '../../analyses/VisualTile';
import { useMetricList } from '../../analyses/metrics/api';
import type { Step } from '../api';
import pk from './Pickers.module.css';

export type ChooserKind = 'visual' | 'metric' | 'metrics_row';

interface Row {
  id: string;
  label: string;
  sub: string;
}

/** The modal list with a search box both record pickers share (stChooser). */
function Chooser({ title, rows, max, loading, error, onDone }: { title: string; rows: Row[]; max: number; loading: boolean; error?: string; onDone: (ids: string[]) => void }) {
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const shown = rows.filter((r) => !q.trim() || r.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onDone([])}
      title={title}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          {max > 1 && (
            <Button variant="primary" disabled={!chosen.length} onClick={() => onDone(chosen)}>
              {chosen.length ? `Add ${chosen.length}` : 'Add'}
            </Button>
          )}
        </>
      }
    >
      <Input aria-label="Search" icon="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {loading ? (
        <SkeletonRows rows={4} label="Loading" />
      ) : error ? (
        <ErrorState compact heading={3} title="Could not load the list" message={error} />
      ) : !shown.length ? (
        <EmptyState compact heading={3} icon="search" title={rows.length ? 'Nothing matches' : 'Nothing saved in this project yet'} />
      ) : (
        <ul className={pk.chooserList} aria-label={title}>
          {shown.map((r) => {
            const on = chosen.includes(r.id);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className={on ? `${pk.chooserRow} ${pk.chosen}` : pk.chooserRow}
                  aria-pressed={max > 1 ? on : undefined}
                  onClick={() => {
                    if (max <= 1) return onDone([r.id]);
                    setChosen((c) => (on ? c.filter((x) => x !== r.id) : c.length < max ? [...c, r.id] : c));
                  }}
                >
                  {max > 1 && <span className={pk.check}>{on && <Icon name="check" size={12} />}</span>}
                  <span className={pk.chooserLabel}>{r.label}</span>
                  <span className={pk.chooserSub}>{r.sub}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

export function ChooseVisual({ projectId, onDone }: { projectId: string; onDone: (id: string | null) => void }) {
  const q = useQuery({
    queryKey: ['visual:list', projectId],
    queryFn: async () => (await rpc('visual:list', { projectId })) as Array<{ id: string; name: string; chartType: string }>,
  });
  const rows = useMemo(() => (q.data ?? []).map((v) => ({ id: v.id, label: v.name || 'Untitled visual', sub: vizLabel(v.chartType) })), [q.data]);
  return <Chooser title="Add a chart" rows={rows} max={1} loading={q.isPending} error={q.isError ? q.error.message : undefined} onDone={(ids) => onDone(ids[0] ?? null)} />;
}

export function ChooseMetrics({ projectId, max, onDone }: { projectId: string; max: number; onDone: (ids: string[]) => void }) {
  const q = useMetricList(projectId);
  const rows = useMemo(() => (q.data ?? []).map((m) => ({ id: m.id, label: m.name, sub: m.description || m.definitionText })), [q.data]);
  return <Chooser title={max > 1 ? `Add up to ${max} metrics` : 'Add a metric'} rows={rows} max={max} loading={q.isPending} error={q.isError ? q.error.message : undefined} onDone={onDone} />;
}

/**
 * The largest picture a story embeds. The store allows 2.8M characters, but a
 * save travels as one RPC under the server's JSON body cap (MAX_RPC_BODY_KB,
 * 1 MB by default) — so the browser keeps a picture well under it.
 */
export const MAX_IMAGE_CHARS = 700_000;

/** An image from this computer as a data: URL — read in the browser, never uploaded as a file. */
export function chooseImage(): Promise<{ src: string; alt: string } | { error: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => {
        const src = String(r.result || '');
        if (src.length > MAX_IMAGE_CHARS) resolve({ error: 'That image is too large — up to about 500 KB.' });
        else resolve({ src, alt: f.name.replace(/\.[a-z0-9]+$/i, '') });
      };
      r.onerror = () => resolve(null);
      r.readAsDataURL(f);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

const OPS = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'in'];

/** Pin a filter to one chart block: column, operator, value — applied on top of the visual's own (stPinFilter). */
export function PinFilter({ projectId, datasetId, onDone }: { projectId: string; datasetId: string; onDone: (step: Step | null) => void }) {
  const q = useDatasetColumns(projectId, datasetId);
  const cols = q.data?.columns ?? [];
  const [col, setCol] = useState('');
  const [op, setOp] = useState('=');
  const [value, setValue] = useState('');
  const column = cols.find((c) => c.name === (col || cols[0]?.name));
  const add = () => {
    const raw = value.trim();
    if (!column || !raw) return;
    // A number column compares as a number, as the desktop's pin did; the server re-checks every step.
    const cast = (x: string): string | number => (column.type === 'number' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : x.trim());
    onDone(op === 'in' ? { type: 'filter', column: column.name, op, values: raw.split(',').map(cast) } : { type: 'filter', column: column.name, op, value: cast(raw) });
  };
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(o) => !o && onDone(null)}
      title="Pin a filter"
      description="Applied to this chart block only, on top of the visual’s own filters."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" disabled={!column || !value.trim()} onClick={add}>
            Pin filter
          </Button>
        </>
      }
    >
      {q.isPending ? (
        <SkeletonRows rows={3} label="Loading columns" />
      ) : !cols.length ? (
        <ErrorState compact heading={3} title="That chart’s dataset could not be read" message="It may have been deleted." />
      ) : (
        <form
          className={pk.pinForm}
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Select label="Column" value={column?.name ?? null} onValueChange={setCol} options={cols.map((c) => ({ value: c.name, label: c.name }))} />
          <Select label="Operator" value={op} onValueChange={setOp} options={OPS.map((o) => ({ value: o, label: o }))} />
          <Input label="Value" hint={op === 'in' ? 'Separate values with commas.' : undefined} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </form>
      )}
    </Dialog>
  );
}
