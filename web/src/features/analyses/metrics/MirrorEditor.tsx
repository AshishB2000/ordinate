// A layer's metric in the metric editor (semantic layer part 7, b3; docs/semantic-layer/07-portability.md D13): the
// sync wrote it as a NAME, and its math and filters live in the layer ("Defined in Snowflake: edit it there."). Its
// name, format, description and direction are Ordinate's. A save sends those four only — never a definition or
// filters — so this editor cannot turn a mirror into a column metric, whatever an older server would do with one.

import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../../api/client';
import { useDatasets } from '../../../api/datasets';
import { Button, buttonClass } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { ConflictBanner } from '../../editConflicts/ConflictBanner';
import { useEditGuard } from '../../editConflicts/useEditGuard';
import { movesPin } from '../../model/status/status';
import { needsWarning, SaveWarning } from '../../model/status/SaveWarning';
import { failure } from '../api';
import type { ExternalDefinition, Metric, MetricFormat } from './api';
import { DirectionSelect, FormatFields, type Direction } from './parts';
import s from './Metrics.module.css';

type Props = {
  projectId: string;
  existing: Partial<Metric> & { definition: ExternalDefinition };
  used?: string;
  onSaved: (m: Metric) => void;
  onClose: () => void;
  onReload: () => void;
};

export function MirrorEditor({ projectId, existing, used, onSaved, onClose, onReload }: Props) {
  const id = existing.id ?? '';
  const guard = useEditGuard({ projectId, type: 'metric', id: id || undefined }, existing.tag);
  const sets = useDatasets(projectId);
  const ds = sets.data?.find((d) => d.id === existing.datasetId);
  const layer = ds?.semantic?.label ?? 'its semantic layer';
  const [name, setName] = useState(existing.name ?? '');
  const f0 = existing.format;
  const [format, setFormat] = useState<MetricFormat>({ kind: f0?.kind ?? 'number', decimals: f0?.decimals ?? 0, prefix: f0?.prefix ?? '', suffix: f0?.suffix ?? '', compact: f0?.compact === true });
  const [description, setDescription] = useState(existing.description ?? '');
  const [direction, setDirection] = useState<Direction>(existing.direction ?? '');
  const [warn, setWarn] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const first = useRef(JSON.stringify({ name: existing.name ?? '', format }));

  const save = async () => {
    setWarn(false);
    setError('');
    if (!name.trim()) return setError('A metric needs a name.');
    setSaving(true);
    try {
      const patch = { name: name.trim(), format, description, direction };
      const r = (await guard.save((base) => rpc('metric:update', { projectId, id, ...(base ? { base } : {}), patch }))) as { ok: boolean; metric?: Metric; error?: string } | null;
      if (r === null) return; // the banner says another save came first
      if (!r.ok || !r.metric) return setError(r.error || 'Could not save the metric.');
      onSaved(r.metric);
      onClose();
    } catch (err) {
      setError(failure(err, 'Could not save the metric.'));
    } finally {
      setSaving(false);
    }
  };
  // A certified metric: a new name or format moves its pin, so the save warns first (D5), as the full editor's does.
  const ask = () => {
    const was = JSON.parse(first.current) as { name: string; format: MetricFormat };
    const changed = { ...(name.trim() !== was.name ? { name: true } : {}), ...(JSON.stringify(format) !== JSON.stringify(was.format) ? { format: true } : {}) };
    if (needsWarning(existing.status, movesPin('metric', changed))) setWarn(true);
    else void save();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Edit metric"
      footer={
        <>
          <Link className={buttonClass('ghost', 'sm', s.history)} to={`/versions/${projectId}/metric/${id}`}>
            <Icon name="history" />
            <span>History</span>
          </Link>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={saving} disabled={guard.changed} onClick={ask}>
            Save
          </Button>
        </>
      }
    >
      {warn && existing.status && <SaveWarning name={name.trim()} status={existing.status} used={used} onConfirm={() => void save()} onCancel={() => setWarn(false)} />}
      {guard.changed && <ConflictBanner compact noun="metric" onReload={onReload} />}
      <div className={s.fields}>
        <Input label="Name" hint="Formulas and the Assistant know it by this name. Its name in the layer stays as it is." value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />
        <div className={s.group}>
          <span className={s.groupLabel}>Dataset</span>
          <span>{ds?.name ?? (sets.isPending ? 'Loading…' : 'This metric’s dataset is no longer in the project.')}</span>
        </div>
        <div className={s.group} data-mirror="">
          <span className={s.groupLabel}>Definition</span>
          <div className={s.mirrorDef}>
            <code>{existing.definition.external}</code>
            <span className={s.groupHint}>{existing.definition.additive ? 'Can be added up' : 'Can’t be added up'}</span>
          </div>
          <span className={s.mirrorNote}>
            <Icon name="layers" size={12} /> {`Defined in ${layer}: edit it there.`}
          </span>
        </div>
        <div className={s.group}>
          <span className={s.groupLabel}>Filters</span>
          <span className={s.groupHint}>{`None in Ordinate: ${layer} applies its own.`}</span>
        </div>
        <div className={s.group}>
          <span className={s.groupLabel}>Format</span>
          <FormatFields format={format} onChange={setFormat} affixes />
        </div>
        <Input label="Description" placeholder="What this number means, for whoever reads it next" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        <DirectionSelect value={direction} onChange={setDirection} />
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
