// The editor's add flows, one open at a time: a visual, a KPI, a text card
// (legacy dashAdd.ts handleAddText — notes run the full width), a filter
// control, a parameter with the chip that moves it (paramDialog.ts
// addParameterControl), and the layout kinds (layoutKinds.ts).

import { useState } from 'react';
import { rpc, upload } from '../../../api/client';
import { toast } from '../../../ui/Toast';
import { useQueryClient } from '@tanstack/react-query';
import { failure, galleryQuery } from '../api';
import { lockedRows, type ImageSpec } from './KindCards';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input, Textarea } from '../../../ui/Field';
import { ParamDialog } from '../ParamDialog';
import { AddKpiDialog } from './AddKpi';
import { AddVisualDialog } from './AddVisual';
import { addGroup } from './arrange';
import { useEditor } from './context';
import { ControlDialog } from './ControlDialog';
import { uuid } from './doc';
import { findSlot } from './geometry';

export type Adding = 'visual' | 'kpi' | 'text' | 'control' | 'param' | null;

function TextDialog({ onClose }: { onClose: () => void }) {
  const ed = useEditor();
  const [heading, setHeading] = useState('');
  const [text, setText] = useState('');
  const empty = !heading.trim() && !text.trim();
  const add = () => {
    if (empty) return;
    const id = uuid();
    ed.edit('Add text', (d) => {
      const sh = d.sheets[ed.sheet];
      sh.cards.push({
        id,
        type: 'text',
        layout: { ...findSlot(sh.cards, 12, 2), w: 12, h: 2 },
        ...(heading.trim() ? { heading: heading.trim() } : {}),
        ...(text.trim() ? { text: text.trim() } : {}),
      });
    });
    ed.select(id);
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add text"
      description="A note, a caption under a row of charts. {{name}} shows a parameter's value."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" disabled={empty} onClick={add}>
            Add
          </Button>
        </>
      }
    >
      <Input label="Heading (optional)" value={heading} onChange={(e) => setHeading(e.target.value)} autoFocus maxLength={200} />
      <Textarea label="Text (optional)" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
    </Dialog>
  );
}

/** Add a divider / container / tabs card (layoutKinds.ts). Containers and tabs wrap the ⇧-selection when there is one. */
export function useAddKind() {
  const ed = useEditor();
  return (kind: 'divider' | 'container' | 'tabs') => {
    const id = uuid();
    if (kind === 'divider') {
      ed.edit('Add divider', (d) => {
        const sh = d.sheets[ed.sheet];
        sh.cards.push({ id, type: 'divider', layout: { ...findSlot(sh.cards, 12, 1), w: 12, h: 1 }, divider: { style: 'line' } });
      });
    } else {
      const around = [...ed.multi];
      ed.edit(`Add ${kind}`, (d) => addGroup(d.sheets[ed.sheet].cards, kind, around, id));
      ed.setMulti(new Set());
    }
    ed.select(id);
  };
}

/**
 * Add an image (layoutKinds.ts handleAddImage): the picked file goes up as a
 * T0.4 upload and the server copies it into the project's assets — PNG, JPG or
 * script-free SVG up to 5 MB; a 4-wide card whose height keeps the aspect.
 */
export function useAddImage() {
  const ed = useEditor();
  return () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const up = await upload(file, file.name);
        const r = (await rpc('asset:importImage', { projectId: ed.projectId, fileToken: up.fileToken })) as
          | { ok: true; asset: { id: string; ext: ImageSpec['ext']; aspect?: number } }
          | { ok: false; error: string };
        if (!r.ok) throw new Error(r.error);
        const id = uuid();
        const image: ImageSpec = { assetId: r.asset.id, ext: r.asset.ext, fit: 'contain', alt: '', lockAspect: true, ...(r.asset.aspect ? { aspect: r.asset.aspect } : {}) };
        ed.edit('Add image', (d) => {
          const sh = d.sheets[ed.sheet];
          sh.cards.push({ id, type: 'image', layout: { ...findSlot(sh.cards, 4, 4), w: 4, h: lockedRows(4, image.aspect, 4) }, image });
        });
        ed.select(id);
      } catch (err) {
        toast(failure(err, 'That image could not be added.'), { kind: 'error' });
      }
    };
    input.click();
  };
}

/** Add a navigation strip (navCard.ts handleAddNav): buttons to up to four other dashboards, or this one's sheets. */
export function useAddNav() {
  const ed = useEditor();
  const client = useQueryClient();
  return async () => {
    // The project's dashboards, read when asked for (not on every canvas load).
    const gallery = await client.fetchQuery(galleryQuery(ed.projectId)).catch(() => []);
    const others = gallery.filter((a) => a.id !== ed.analysisId).slice(0, 4);
    const items = others.length
      ? others.map((a) => ({ id: uuid(), label: (a.name || 'Open').slice(0, 60), icon: 'layout-dashboard', target: { analysisId: a.id } }))
      : ed.doc.sheets.map((p) => ({ id: uuid(), label: (p.name || 'Open').slice(0, 60), target: { analysisId: ed.analysisId, page: p.id } }));
    const id = uuid();
    ed.edit('Add navigation', (d) => {
      const sh = d.sheets[ed.sheet];
      sh.cards.push({ id, type: 'nav', layout: { ...findSlot(sh.cards, 12, 1), w: 12, h: 1 }, nav: { style: 'buttons', items: items.slice(0, 12) } });
    });
    ed.select(id);
  };
}

export function AddDialogs({ adding, onClose, onSwitch }: { adding: Adding; onClose: () => void; onSwitch: (a: Adding) => void }) {
  const ed = useEditor();
  if (adding === 'visual') return <AddVisualDialog onClose={onClose} />;
  if (adding === 'kpi') return <AddKpiDialog onClose={onClose} />;
  if (adding === 'text') return <TextDialog onClose={onClose} />;
  if (adding === 'control') {
    return (
      <ControlDialog
        projectId={ed.projectId}
        onClose={onClose}
        onParameter={() => onSwitch('param')}
        onDone={(control) => {
          const id = uuid();
          // A control is a filter-bar chip, not a tile: its layout places nothing.
          ed.edit('Add control', (d) => void d.sheets[ed.sheet].cards.push({ id, type: 'control', control, layout: { x: 0, y: 0, w: 0, h: 0 } }));
          if (control.default) ed.setControl(id, control.default);
        }}
      />
    );
  }
  if (adding === 'param') {
    return (
      <ParamDialog
        others={ed.doc.parameters.map((p) => p.name)}
        onClose={onClose}
        onDone={(param, label) => {
          const pid = uuid();
          const cid = uuid();
          ed.edit('Add parameter', (d) => {
            d.parameters.push({ ...param, id: pid });
            d.sheets[ed.sheet].cards.push({
              id: cid,
              type: 'control',
              control: { kind: 'parameter', label, datasetId: '', column: '', paramId: pid },
              layout: { x: 0, y: 0, w: 0, h: 0 },
            });
          });
        }}
      />
    );
  }
  return null;
}
