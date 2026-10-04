// "+ Visual" (legacy dashAdd.ts openVisualPicker): a saved visual onto the
// sheet, or a new one — made in the Visuals builder, which owns encodings,
// chart types and formatting (T2.7). A card references its visual by id.

import { useState } from 'react';
import { Link } from 'react-router';
import { shortTime } from '../../../app/when';
import { Button, buttonClass } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { vizGlyph, vizLabel } from '../VisualTile';
import { useEditor } from './context';
import { findSlot } from './geometry';
import { uuid } from './doc';
import s from './Dialogs.module.css';

/** The Visuals builder's route for a new visual / an existing one (T2.7). */
export const builderNew = (projectId: string) => `/visuals/${projectId}/new`;
export const builderFor = (projectId: string, visualId: string) => `/visuals/${projectId}/${visualId}`;

/** Put a visual card on the open sheet (6×6 at the first free cell) and select it. */
export function useAddVisualCard() {
  const ed = useEditor();
  return (visualId: string, name: string) => {
    const id = uuid();
    ed.edit(`Add ${name || 'visual'}`, (d) => {
      const sheet = d.sheets[ed.sheet];
      sheet.cards.push({ id, type: 'visual', visualId, layout: { ...findSlot(sheet.cards, 6, 6), w: 6, h: 6 } });
    });
    ed.select(id);
  };
}

export function AddVisualDialog({ onClose }: { onClose: () => void }) {
  const ed = useEditor();
  const add = useAddVisualCard();
  const [q, setQ] = useState('');
  const all = [...ed.visuals.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const shown = all.filter((v) => !q.trim() || v.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Add a visual"
      description="Pick a saved visual — the card shows it live, and editing the visual changes it everywhere it is used."
      footer={
        <DialogClose asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogClose>
      }
    >
      <div className={s.pickBar}>
        <Input icon="search" type="search" aria-label="Search visuals" placeholder="Search visuals" value={q} onChange={(e) => setQ(e.target.value)} />
        <Link className={buttonClass('secondary')} to={builderNew(ed.projectId)}>
          <Icon name="plus" />
          <span>New visual</span>
        </Link>
      </div>
      {all.length === 0 ? (
        <p className={s.empty}>No saved visuals yet — make one in the Visuals builder, then add it here.</p>
      ) : shown.length === 0 ? (
        <p className={s.empty}>No visual matches “{q.trim()}”.</p>
      ) : (
        <div className={s.pickGrid}>
          {shown.map((v) => (
            <button
              key={v.id}
              type="button"
              className={s.pickTile}
              onClick={() => {
                add(v.id, v.name);
                onClose();
              }}
            >
              <span className={s.pickGlyph} aria-hidden="true">
                <Icon name={vizGlyph(v.chartType)} size={20} />
              </span>
              <span className={s.pickName}>{v.name || 'Untitled visual'}</span>
              <span className={s.pickMeta}>
                {vizLabel(v.chartType)} · {shortTime(v.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
