// The dataset composer — the one create-a-dataset surface (legacy
// composer.ts): the tables being combined as a chain, a live preview from the
// server, the field mapping on the preview's own header, and Save. Every
// source ends here — a file, a paste, a screenshot's table, a saved dataset —
// so importing IS composing.
//
// The browser never computes a joined row, a count or a type: the preview is
// dataset:composePreview's answer (folded from the first 50k rows per table,
// which its warnings say), and the save is dataset:composeSave, a job.

import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { formatNumber } from '../../../../src/app/format.ts';
import { Button } from '../../ui/Button';
import { toast } from '../../ui/Toast';
import { composePreview, composeSave, type ComposeInput } from './api';
import { joinsOf, mappingSteps, missingKey, retypeOf, type ChainTable, type ColMap, type Link } from './composerModel';
import { ComposerChain } from './ComposerChain';
import { ComposerPreview } from './ComposerPreview';
import cs from './Composer.module.css';
import s from './Import.module.css';

export interface ComposerStart {
  /** The table to start from; null opens an empty canvas ("Combine datasets"). */
  base: ChainTable | null;
  name: string;
  sourceKind?: ComposeInput['sourceKind'];
  origin?: ComposeInput['origin'];
  /** A screenshot capture: its cells are a model's reading, so they may be corrected here. */
  capture?: boolean;
  /** The model said it was unsure about some of what it read. */
  unsure?: boolean;
  /** What the parse warned about (ragged rows, the row cap). */
  warnings?: readonly string[];
  /** The sheet a workbook import came from, said beside it. */
  sheet?: string;
}

const plural = (n: number, one: string) => `${formatNumber(n)} ${one}${n === 1 ? '' : 's'}`;

export function Composer({ projectId, start, onBack }: { projectId: string; start: ComposerStart; onBack: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [base, setBase] = useState<ChainTable | null>(start.base);
  const [links, setLinks] = useState<Link[]>([]);
  const [map, setMap] = useState<Record<string, ColMap>>({});
  const [name, setName] = useState(start.name);
  const [openJoin, setOpenJoin] = useState(-1);
  const [saving, setSaving] = useState(false);

  const joins = useMemo(() => joinsOf(links), [links]);
  const chainKey = JSON.stringify([base?.ref ?? null, joins]);
  // The chain's head: columns, total and warnings (no rows — the grid pages those).
  const head = useQuery({
    queryKey: ['dataset:composePreview', projectId, chainKey],
    queryFn: async () => {
      if (!base) return null;
      const r = await composePreview({ projectId, base: base.ref, joins, offset: 0, limit: 0 });
      if (!r.ok) throw new Error(r.error);
      return r;
    },
    placeholderData: keepPreviousData,
  });
  const raw = head.data?.columns ?? [];
  // Only a bare capture base is cell-editable: with a join on the canvas a
  // preview cell is a fold's output, not a source cell.
  const editable = !!start.capture && links.length === 0 && !!base && 'inline' in base.ref;
  const kept = raw.filter((c) => !map[c.name]?.dropped).length;

  const save = async () => {
    if (!base) return;
    const missing = links.findIndex(missingKey);
    if (missing >= 0) {
      toast(`Choose a join key for “${links[missing].table.label}” first.`, { kind: 'error' });
      setOpenJoin(missing);
      return;
    }
    const finalName = name.trim() || base.label || 'Untitled dataset';
    setSaving(true);
    try {
      const r = await composeSave({
        projectId,
        name: finalName,
        base: base.ref,
        joins,
        steps: mappingSteps(raw, map),
        ...(start.sourceKind ? { sourceKind: start.sourceKind } : {}),
        ...(start.origin ? { origin: start.origin } : {}),
        ...(retypeOf(raw, map) ? { retype: retypeOf(raw, map) } : {}),
      });
      if (!r.ok) {
        toast(r.canceled ? 'Import cancelled.' : r.error || 'The dataset could not be saved.', { kind: r.canceled ? 'info' : 'error' });
        return;
      }
      for (const w of r.warnings) toast(w);
      toast(`Saved “${finalName}”.`, { kind: 'success' });
      void client.invalidateQueries({ queryKey: ['dataset:list', projectId] });
      void client.invalidateQueries({ queryKey: ['captureDataset:list', projectId] });
      void navigate(`/data/${projectId}/${r.dataset.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The dataset could not be saved.', { kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const notes = [
    ...(start.unsure ? ['The model was unsure about some of what it read. Check the cells before you save — any of them can be corrected here.'] : []),
    ...(start.warnings ?? []),
    ...(head.data?.warnings ?? []),
  ];

  return (
    <div className={cs.composer}>
      <div className={cs.composerHead}>
        <Button size="sm" icon="arrow-left" onClick={onBack}>
          Back to sources
        </Button>
        <input className={cs.nameInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Dataset name" aria-label="Dataset name" maxLength={200} />
        <span className={s.count} aria-live="polite">
          {head.data ? `${plural(head.data.total, 'row')} · ${plural(kept, 'column')}` : ''}
        </span>
        <Button variant="primary" loading={saving} disabled={!base || !head.data} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <div className={cs.composerBody}>
        <ComposerChain
          projectId={projectId}
          base={base}
          links={links}
          previewCols={raw}
          sheet={start.sheet}
          openJoin={openJoin}
          onOpenJoin={setOpenJoin}
          onBase={(b) => {
            setBase(b);
            if (!name.trim()) setName(b.label);
          }}
          onLinks={setLinks}
        />
        <ComposerPreview
          projectId={projectId}
          base={base}
          joins={joins}
          chainKey={chainKey}
          head={head}
          map={map}
          onMap={setMap}
          notes={notes}
          editable={editable}
          onEditBase={setBase}
        />
      </div>
    </div>
  );
}
