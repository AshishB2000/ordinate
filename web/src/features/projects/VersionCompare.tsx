// Compare two saved versions of a record before restoring one
// (docs/version-diff/00-design.md), in the history page's right-hand pane:
// which two (pickers), the server's summary line, a dashboard's layout per sheet
// with each tile coloured by what happened to it, the KPI figures each spec gives
// NOW (VersionFigures), and every change as the server's sentence. Every word and
// every figure is the server's; this screen only lays them out.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import type { IconName } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { fmtWhen, useCan, useChange, useVersionDiff, type DiffChange, type VersionDiff, type VersionMeta, type VersionType } from './api';
import { VersionFigures } from './VersionFigures';
import { LayoutThumb } from './VersionPreview';
import s from './VersionCompare.module.css';

/** "Current" for the newest save, else its number: v1 is the oldest kept. */
export function versionLabel(versions: readonly VersionMeta[], key: string): string {
  const i = versions.findIndex((v) => v.key === key);
  if (i < 0) return 'A removed version';
  return i === 0 ? 'Current' : `v${versions.length - i}`;
}

const GROUPS: { group: DiffChange['group'][]; title: string }[] = [
  { group: ['record', 'sheets'], title: 'The record' },
  { group: ['filters'], title: 'Filters' },
  { group: ['cards'], title: 'Cards' },
];

/** Shown per group before "Show N more". */
const FIRST = 12;

function changeIcon(kind: string): { icon: IconName; tone: string } {
  if (kind.endsWith('.added') || kind.endsWith('Added') || kind === 'step.added') return { icon: 'plus', tone: s.added };
  if (kind.endsWith('.removed') || kind.endsWith('Removed')) return { icon: 'minus', tone: s.removed };
  if (kind.startsWith('card.moved') || kind === 'card.resized' || kind.endsWith('reordered') || kind.endsWith('Reordered')) return { icon: 'arrow-right', tone: s.moved };
  if (kind.startsWith('filter.')) return { icon: 'filter', tone: s.changed };
  return { icon: 'pencil', tone: s.changed };
}

function Words({ words }: { words: NonNullable<DiffChange['words']> }) {
  return (
    <p className={s.words}>
      {words.map((w, i) => {
        const text = (i > 0 ? ' ' : '') + w.text;
        if (w.op === 'add') return <ins key={i}>{text}</ins>;
        if (w.op === 'del') return <del key={i}>{text}</del>;
        return <span key={i}>{text}</span>;
      })}
    </p>
  );
}

function ChangeGroup({ title, changes }: { title: string; changes: DiffChange[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? changes : changes.slice(0, FIRST);
  return (
    <section className={s.group} aria-label={title}>
      <h4 className={s.groupTitle}>
        {title}
        <span className={s.count}>{changes.length}</span>
      </h4>
      <ul className={s.changes}>
        {shown.map((c, i) => {
          const { icon, tone } = changeIcon(c.kind);
          return (
            <li key={i} className={s.change}>
              <span className={`${s.changeIc} ${tone}`}>
                <Icon name={icon} size={12} />
              </span>
              <span className={s.changeBody}>
                <span>{c.text}</span>
                {c.words && c.words.length > 0 && <Words words={c.words} />}
              </span>
            </li>
          );
        })}
      </ul>
      {changes.length > FIRST && (
        <Button size="sm" variant="ghost" icon={all ? 'chevron-up' : 'chevron-down'} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show ${changes.length - FIRST} more`}
        </Button>
      )}
    </section>
  );
}

const LEGEND: { status: string; label: string }[] = [
  { status: 'added', label: 'Added' },
  { status: 'removed', label: 'Removed' },
  { status: 'changed', label: 'Changed' },
  { status: 'moved', label: 'Moved' },
];

function Layouts({ diff, fromLabel, toLabel }: { diff: VersionDiff; fromLabel: string; toLabel: string }) {
  const sheets = diff.sheets.filter((x) => x.changed);
  if (!sheets.length) return null;
  return (
    <section className={s.section} aria-label="Layout">
      <div className={s.sectionHead}>
        <h3>Layout</h3>
        <ul className={s.legend} aria-label="Legend">
          {LEGEND.map((l) => (
            <li key={l.status}>
              <span className={s.swatch} data-status={l.status} aria-hidden="true" />
              {l.label}
            </li>
          ))}
        </ul>
      </div>
      {sheets.map((sheet) => {
        const tiles = [...(sheet.before ?? []), ...(sheet.after ?? [])];
        const rows = Math.max(8, ...tiles.map((t) => t.y + t.h));
        const side = (label: string, list: typeof sheet.before) => (
          <figure className={s.thumbSide}>
            {list ? (
              <LayoutThumb tiles={list} rows={rows} width={300} height={Math.round(Math.min(220, Math.max(130, rows * 9)))} />
            ) : (
              <div className={s.thumbNone}>Not in {label}</div>
            )}
            <figcaption>{label}</figcaption>
          </figure>
        );
        return (
          <div key={sheet.id} className={s.sheet}>
            {diff.sheets.length > 1 && <h4 className={s.sheetName}>{sheet.name}</h4>}
            <div className={s.thumbPair}>
              {side(fromLabel, sheet.before)}
              <Icon name="arrow-right" size={16} />
              {side(toLabel, sheet.after)}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Chips({ counts }: { counts: VersionDiff['counts'] }) {
  const chips: [number, string, string][] = [
    [counts.changed, 'changed', s.changed],
    [counts.added, 'added', s.added],
    [counts.removed, 'removed', s.removed],
    [counts.moved, 'moved', s.moved],
    [counts.filters, counts.filters === 1 ? 'filter' : 'filters', s.changed],
    [counts.other, 'other', s.neutral],
  ];
  return (
    <span className={s.chips}>
      {chips.filter(([n]) => n > 0).map(([n, word, tone]) => (
        <span key={word} className={`${s.chip} ${tone}`}>
          {n} {word}
        </span>
      ))}
    </span>
  );
}

export interface CompareProps {
  projectId: string;
  type: VersionType;
  id: string;
  versions: readonly VersionMeta[];
  from: string;
  to: string;
  onPick: (from: string, to: string) => void;
  onClose: () => void;
}

export function VersionCompare({ projectId, type, id, versions, from, to, onPick, onClose }: CompareProps) {
  const diff = useVersionDiff(projectId, type, id, from, to);
  const can = useCan(projectId);
  const [confirm, setConfirm] = useState(false);
  const newest = versions[0]?.key;
  const fromLabel = versionLabel(versions, from);
  const toLabel = versionLabel(versions, to);
  // Restore the older side when the other one is current: that is what "restore v3" means here.
  const target = to === newest && from !== newest ? from : from === newest && to !== newest ? to : null;
  const targetMeta = versions.find((v) => v.key === target);
  const targetLabel = target ? versionLabel(versions, target) : '';
  const restore = useChange<'versions:restore', { ok: boolean; error?: string; unchanged?: boolean }>(
    'versions:restore',
    ['versions:list', 'versions:get', 'versions:diff', 'trash:list'],
    (r) => {
      setConfirm(false);
      if (!r.ok) return void toast(r.error ?? 'Could not restore that version.', { kind: 'error' });
      toast(r.unchanged ? 'That version is already the current one.' : `Restored ${targetLabel} — the version before it is still in the history.`, { kind: 'success' });
      onClose();
    },
  );

  const options = versions.map((v) => ({ value: v.key, label: `${versionLabel(versions, v.key)} · ${fmtWhen(v.savedAt)}` }));
  const sideMeta = (key: string) => {
    const v = versions.find((x) => x.key === key);
    return v ? [fmtWhen(v.savedAt), v.by ? `by ${v.by}` : ''].filter(Boolean).join(' · ') : '';
  };

  let body;
  if (diff.isPending) {
    body = (
      <div className={s.loading} aria-busy="true">
        <Skeleton className={s.skLine} />
        <div className={s.thumbPair}>
          <Skeleton className={s.skThumb} />
          <Skeleton className={s.skThumb} />
        </div>
        <SkeletonRows rows={5} label="Comparing the two versions" />
      </div>
    );
  } else if (diff.isError) {
    body = <ErrorState compact heading={3} title="These versions could not be compared" message={diff.error.message} onRetry={() => void diff.refetch()} />;
  } else if (diff.data.changes.length === 0) {
    body = (
      <EmptyState heading={3} icon="circle-check" title="These two versions are the same">
        {`Nothing a reader would see differs between ${fromLabel} and ${toLabel.toLowerCase() === 'current' ? 'the current version' : toLabel}.`}
      </EmptyState>
    );
  } else {
    const d = diff.data;
    body = (
      <>
        <div className={s.summary} role="status">
          <span className={s.summaryIc}>
            <Icon name="history" />
          </span>
          <span className={s.summaryText}>
            <strong>{d.summary}</strong>
            <Chips counts={d.counts} />
          </span>
        </div>
        {type === 'dashboard' && <Layouts diff={d} fromLabel={fromLabel} toLabel={toLabel} />}
        {d.figures > 0 && <VersionFigures projectId={projectId} type={type} id={id} from={from} to={to} rows={d.figures} fromLabel={fromLabel} toLabel={toLabel} />}
        <section className={s.section} aria-label="Changes">
          <div className={s.sectionHead}>
            <h3>What changed</h3>
          </div>
          {GROUPS.map((g) => {
            const list = d.changes.filter((c) => g.group.includes(c.group));
            return list.length ? <ChangeGroup key={g.title} title={g.title} changes={list} /> : null;
          })}
        </section>
      </>
    );
  }

  const ready = diff.isSuccess && diff.data.changes.length > 0;
  return (
    <div className={s.compare}>
      <header className={s.head}>
        <div className={s.pick}>
          <Select size="sm" aria-label="Compare from" value={from} options={options} onValueChange={(v) => onPick(v, to)} />
          <span className={s.sideMeta}>{sideMeta(from)}</span>
        </div>
        <span className={s.arrow} aria-hidden="true">
          <Icon name="arrow-right" size={16} />
        </span>
        <div className={s.pick}>
          <Select size="sm" aria-label="Compare to" value={to} options={options} onValueChange={(v) => onPick(from, v)} />
          <span className={s.sideMeta}>{sideMeta(to)}</span>
        </div>
        <span className={s.headActions}>
          <Button size="sm" variant="ghost" onClick={() => onPick(to, from)}>
            Swap
          </Button>
          <Button size="sm" variant="ghost" icon="x" onClick={onClose}>
            Close
          </Button>
        </span>
      </header>
      {body}
      {ready && target && targetMeta && can('editor') && (
        <footer className={s.foot}>
          <span>{`Restoring ${targetLabel} saves it again as the newest version — the current one stays in the history.`}</span>
          <Button size="sm" variant="primary" icon="rotate-ccw" onClick={() => setConfirm(true)}>
            {`Restore ${targetLabel}`}
          </Button>
        </footer>
      )}
      {ready && target && (
        <Dialog
          open={confirm}
          onOpenChange={setConfirm}
          size="sm"
          title={`Restore ${targetLabel}?`}
          description={targetMeta ? `Saved ${fmtWhen(targetMeta.savedAt)}${targetMeta.by ? ` by ${targetMeta.by}` : ''}.` : undefined}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button variant="primary" icon="rotate-ccw" loading={restore.isPending} onClick={() => restore.mutate({ projectId, type, id, key: target })}>
                {`Restore ${targetLabel}`}
              </Button>
            </>
          }
        >
          <p className={s.confirm}>{`Between ${fromLabel} and ${toLabel === 'Current' ? 'the current version' : toLabel}: ${diff.data.summary}.`}</p>
          <p className={s.confirmNote}>Restoring is itself a save, so it can be undone from this history.</p>
        </Dialog>
      )}
    </div>
  );
}
