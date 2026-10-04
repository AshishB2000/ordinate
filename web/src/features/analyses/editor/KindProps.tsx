// Properties for the kinds beyond KPI / text / control / layout (legacy
// layoutKinds.ts renderImageProps, navCard.ts renderNavProps, authoringProps.ts
// Interactions). Image and navigation settings live on the dashboard record —
// ordinary undoable edits. A visual's click-to-filter and tooltips are the
// SAVED VISUAL's overrides, written through visual:update like the builder.

import { useState } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../../api/client';
import { Button, buttonClass } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { failure, useGallery, type Card, type VisualDef } from '../api';
import { vizLabel } from '../VisualTile';
import { useEditor } from './context';
import type { Doc } from './doc';
import { lockedRows, MAX_NAV_ITEMS, NAV_ICONS, type ImageSpec, type NavItem, type NavSpec, type StatsSpec } from './KindCards';
import s from './Properties.module.css';

type Edit = (label: string, fn: (c: Card, d: Doc) => void, coalesce?: boolean) => void;

export function ImageProps({ card, set }: { card: Card; set: Edit }) {
  const img = card.image as ImageSpec;
  const patch = (label: string, p: Partial<ImageSpec>, coalesce = false) =>
    set(
      label,
      (c) => {
        const next = { ...(c.image as ImageSpec), ...p };
        c.image = next;
        if (p.lockAspect && next.aspect) c.layout = { ...c.layout, h: lockedRows(c.layout.w, next.aspect, c.layout.h) };
      },
      coalesce,
    );
  return (
    <>
      <Input
        label="Alt text"
        value={img.alt}
        placeholder="Describe the image"
        maxLength={300}
        hint="What a screen reader says. Leave empty for a decorative image."
        onChange={(e) => patch('Edit alt text', { alt: e.target.value }, true)}
      />
      <Select
        label="Fit"
        value={img.fit}
        options={[
          { value: 'contain', label: 'Fit inside' },
          { value: 'cover', label: 'Fill and crop' },
          { value: 'fill', label: 'Stretch' },
        ]}
        onValueChange={(v) => patch('Change image fit', { fit: v as ImageSpec['fit'] })}
      />
      <Checkbox label="Lock aspect ratio" checked={img.lockAspect !== false} disabled={!img.aspect} onCheckedChange={(v) => patch('Lock aspect', { lockAspect: v })} />
    </>
  );
}

/** What a target is missing (cardModel.ts targetWarnings). */
function targetWarning(target: NavItem['target'], dashboards: { id: string; sheets: { id: string }[] }[] | undefined): string {
  if (!dashboards) return '';
  if (!target) return 'Choose a dashboard to open.';
  const an = dashboards.find((d) => d.id === target.analysisId);
  if (!an) return 'The target dashboard no longer exists.';
  if (target.page && !an.sheets.some((p) => p.id === target.page)) return 'The target page no longer exists — it will open on its first page.';
  return '';
}

export function NavProps({ card, set }: { card: Card; set: Edit }) {
  const ed = useEditor();
  const gallery = useGallery(ed.projectId);
  const nav = (card.nav as NavSpec | undefined) ?? { style: 'buttons', items: [] };
  const write = (label: string, next: NavSpec, coalesce = false) => set(label, (c) => void (c.nav = next), coalesce);
  const items = nav.style === 'back' ? nav.items.slice(0, 1) : nav.items;
  const dashboards = gallery.data;
  const dashOptions = [
    { value: '', label: 'Choose a dashboard' },
    ...(dashboards ?? []).map((d) => ({ value: d.id, label: d.id === ed.analysisId ? `${d.name} (this one)` : d.name || 'Untitled dashboard' })),
  ];
  const setItem = (i: number, p: Partial<NavItem>, label = 'Edit navigation', coalesce = false) =>
    write(label, { ...nav, items: nav.items.map((it, k) => (k === i ? { ...it, ...p } : it)) }, coalesce);
  return (
    <>
      <Select
        label="Style"
        value={nav.style}
        options={[
          { value: 'buttons', label: 'Buttons' },
          { value: 'tabs', label: 'Tabs' },
          { value: 'back', label: 'Back to overview' },
        ]}
        onValueChange={(v) => write('Change navigation style', { ...nav, style: v as NavSpec['style'] })}
      />
      {nav.style === 'back' && <p className={s.note}>Goes back to the dashboard a reader came from, or to the dashboard you choose below.</p>}
      {gallery.isError && <p className={s.note}>The dashboards could not be listed, so targets cannot be checked right now.</p>}
      {items.map((it, i) => {
        const chosen = dashboards?.find((d) => d.id === it.target?.analysisId);
        const warn = nav.style === 'back' && !it.target ? '' : targetWarning(it.target, dashboards);
        return (
          <fieldset key={it.id} className={s.navRow}>
            <legend className={s.navLegend}>
              {nav.style === 'back' ? 'Overview' : `Button ${i + 1}`}
              {nav.style !== 'back' && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove button ${i + 1}`}
                  onClick={() => write('Remove button', { ...nav, items: nav.items.filter((_, k) => k !== i) })}
                />
              )}
            </legend>
            <Input label="Label" value={it.label} placeholder="Open" maxLength={60} onChange={(e) => setItem(i, { label: e.target.value }, 'Edit navigation', true)} />
            {nav.style !== 'back' && (
              <Select
                label="Icon"
                value={it.icon ?? ''}
                options={[{ value: '', label: 'No icon' }, ...NAV_ICONS.map((n) => ({ value: n, label: n.replace(/-/g, ' ') }))]}
                onValueChange={(v) => setItem(i, { icon: v || undefined })}
              />
            )}
            <Select label="Dashboard" value={it.target?.analysisId ?? ''} options={dashOptions} onValueChange={(v) => setItem(i, { target: v ? { analysisId: v } : undefined })} />
            {chosen && chosen.sheets.length > 1 && (
              <Select
                label="Page"
                value={it.target?.page ?? ''}
                options={[{ value: '', label: 'Its first page' }, ...chosen.sheets.map((p) => ({ value: p.id, label: p.name }))]}
                onValueChange={(v) => setItem(i, { target: v ? { analysisId: chosen.id, page: v } : { analysisId: chosen.id } })}
              />
            )}
            {nav.style !== 'back' && <CarryField item={it} onChange={(carry) => setItem(i, { carry })} />}
            {warn && (
              <p className={s.warn} role="status">
                <Icon name="alert" size={12} />
                {warn}
              </p>
            )}
          </fieldset>
        );
      })}
      {nav.style !== 'back' && nav.items.length < MAX_NAV_ITEMS && (
        <Button size="sm" icon="plus" onClick={() => write('Add button', { ...nav, items: [...nav.items, { id: crypto.randomUUID(), label: 'Open' }] })}>
          Add button
        </Button>
      )}
    </>
  );
}

/** "region = West": the one filter a button carries to its target. Typed as text; the server keeps it as given. */
function CarryField({ item, onChange }: { item: NavItem; onChange: (carry: NavItem['carry']) => void }) {
  const [text, setText] = useState(item.carry ? `${item.carry.column} = ${String(item.carry.value)}` : '');
  return (
    <Input
      label="Carry a filter"
      value={text}
      placeholder="region = West"
      hint="Optional: opens the dashboard with this filter on."
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(text);
        onChange(m ? { column: m[1] as string, value: m[2] as string } : undefined);
      }}
    />
  );
}

/** A visual card's Interactions (authoringProps.ts anRenderInteractions): written to the SAVED visual. */
export function InteractionProps({ def }: { def: VisualDef }) {
  const ed = useEditor();
  const [busy, setBusy] = useState(false);
  const ov = def.overrides ?? {};
  const noClick = def.chartType === 'table' || def.chartType.startsWith('map_');
  const write = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = (await rpc('visual:update', { projectId: ed.projectId, id: def.id, overrides: { ...ov, ...patch } })) as { ok: boolean; visual?: VisualDef; error?: string };
      if (!r.ok || !r.visual) throw new Error(r.error || 'The visual could not be updated.');
      const v = r.visual;
      ed.addVisuals([{ ...def, overrides: v.overrides ?? {}, updatedAt: v.updatedAt }]);
    } catch (err) {
      toast(failure(err, 'The visual could not be updated.'), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Checkbox
        label="Clicking this visual filters the sheet"
        checked={ov.crossFilter === true}
        disabled={busy || noClick || !def.encoding.category}
        onCheckedChange={(v) => void write({ crossFilter: v })}
      />
      <p className={s.note}>
        {noClick
          ? `Click-to-filter does not apply to a ${vizLabel(def.chartType)}.`
          : def.encoding.category
            ? `A click on a mark filters every card on the sheet to that ${def.encoding.category}; click it again to clear it.`
            : 'Give this visual a category first.'}
      </p>
      <Checkbox label="Show tooltips" checked={ov.showTooltips !== false} disabled={busy} onCheckedChange={(v) => void write({ showTooltips: v })} />
      <p className={s.note}>Both are the visual’s own settings: they change it everywhere it is used. Tile actions saved on this card run where the dashboard is viewed.</p>
    </>
  );
}

/** A statistics card stores only its spec; the analysis is changed in the Statistics workbench. */
export function StatsProps({ card }: { card: Card }) {
  const ed = useEditor();
  const spec = card.stats as StatsSpec | undefined;
  return (
    <>
      <p className={s.note}>A statistics card stores only the analysis, and recomputes it under the sheet’s filters every time it is drawn.</p>
      {spec && (
        <Link className={buttonClass('secondary', 'sm')} to={`/analytics/${ed.projectId}/${spec.datasetId}/stats`}>
          <Icon name="chart-bar" />
          <span>Open in Statistics</span>
        </Link>
      )}
    </>
  );
}
