// "As of" (snapshotAsOf.ts): show a chart against a kept snapshot time. VIEW
// STATE ONLY — the chosen time is sent with each read (src/data/asOf.ts
// resolves every dataset as of it on the server), never saved, and back to
// Latest whenever the builder opens. Hidden when there is nothing to pick.

import { Select } from '../../../ui/Select';
import { useStamps, when, whenAll } from './api';
import s from './Snapshots.module.css';

export function AsOfPicker({ projectId, datasetIds, value, onChange }: { projectId: string; datasetIds: string[]; value: string | null; onChange: (v: string | null) => void }) {
  const stamps = useStamps(projectId, datasetIds);
  const items = stamps.data ?? [];
  if (!items.length && !value) return null;
  const many = datasetIds.length > 1;
  const labels = whenAll(items.map((it) => it.at));
  const options = [
    { value: '', label: 'Latest' },
    ...items.map((it, i) => ({ value: it.at, label: labels[i] + (many ? ` — ${it.datasets.join(', ')}` : '') })),
    ...(value && !items.some((it) => it.at === value) ? [{ value, label: when(value) }] : []),
  ];
  return (
    <div className={value ? `${s.asOf} ${s.asOfOn}` : s.asOf}>
      <span className={s.asOfLabel} aria-hidden="true">
        As of
      </span>
      <Select size="sm" aria-label="Show the data as of" value={value ?? ''} options={options} onValueChange={(v) => onChange(v || null)} />
    </div>
  );
}
