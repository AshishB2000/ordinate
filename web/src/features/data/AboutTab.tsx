// The dataset page's About tab: what one row of the table is and how to use it. Role (fact or
// dimension), key, grain and a markdown guide, kept with the project's catalog and read by the
// Assistant and by MCP clients. The key line is the server's count over every row: unique, or how
// many values repeat, and when. A field saves on blur or pick; the server's refusal (a key that is
// not a column of this dataset) is said at the field. "Check now" counts the key again; on a Live
// dataset it is the only thing that asks the warehouse. A viewer of the project reads it all as text.

import { useRef, useState, type ReactNode } from 'react';
import type { DatasetColumns } from '../../api/datasets';
import { Button } from '../../ui/Button';
import { RadioGroup } from '../../ui/Choice';
import { Input, Textarea } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { MarkdownView } from '../dashboards/Markdown';
import { LiveRefusal } from '../live/LiveOff';
import { liveRefusalOf } from '../live/refusal';
import { useCanEdit } from '../projects/api';
import { ago, formatNumber } from './format';
import { useTableDoc, useTableWrites, type KeyCheck, type TableDoc, type TablePatch, type TableReply } from './tableApi';
import a from './About.module.css';
import s from './Data.module.css';

const ROLES = [
  { value: 'fact', label: 'Fact', hint: 'One row per event, like an order or a page view.' },
  { value: 'dimension', label: 'Dimension', hint: 'One row per thing you look up, like a customer or a product.' },
  { value: '', label: 'Not said' },
] as const;
const roleWord = (role: string): string => ROLES.find((r) => r.value === role)?.label ?? 'Not said';

/** The server's bounds (src/api/catalog.ts TablePatch), said at the field instead of cut silently. */
const MAX_GRAIN = 200;
const MAX_GUIDE = 8000;

/** A `{{name}}` in a guide is only text here: there is no metric or parameter to fill it from. */
const keepToken = (name: string) => ({ text: `{{${name}}}`, missing: true });

type Slot = keyof TablePatch;

/** "today", "Oct 3", or "Oct 3, 2025" for another year; '' for a stamp that is not a date. */
function dayOf(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === now.toDateString()) return 'today';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) }).format(d);
}

const plural = (n: number, one: string, many: string): string => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** The counts as one sentence. Every number in it was counted by the server. */
function keyCounts(key: string, c: KeyCheck): { text: string; unique: boolean; when: string } {
  const unique = c.repeatedKeys === 0;
  const parts = [`Key ${key}`, unique ? 'unique' : plural(c.repeatedKeys, 'value repeats', 'values repeat')];
  if (c.empty > 0) parts.push(`${plural(c.empty, 'row has', 'rows have')} no key`);
  const day = dayOf(c.checkedAt);
  return { text: parts.join(' · '), unique, when: day ? `checked ${day}` : '' };
}

function Line({ icon, tone, children }: { icon: 'circle-check' | 'alert' | 'info' | 'refresh'; tone?: 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  const cls = [a.line, tone === 'ok' && a.lineOk, tone === 'warn' && a.lineWarn, tone === 'bad' && a.lineBad].filter(Boolean).join(' ');
  return (
    <p className={cls} data-key-line="">
      <Icon name={icon} size={16} />
      <span className={a.sentence}>{children}</span>
    </p>
  );
}

/** What is known about the declared key: unique, repeating, gone from the columns, or not counted. */
function KeyLine({ table, known, scoped }: { table: TableDoc; known: boolean; scoped: boolean }) {
  const { key, keyCheck: c } = table;
  if (!known) return <Line icon="alert" tone="bad">{`${key} is no longer a column`}</Line>;
  if (!c) {
    return (
      <Line icon="info">{scoped ? `Key ${key} · counts are hidden: your access covers only some of the rows` : `Key ${key} · not checked yet`}</Line>
    );
  }
  const { text, unique, when } = keyCounts(key, c);
  // A repeating key reads as one sentence with its date; a unique one keeps the date beside it, softer.
  return unique ? (
    <Line icon="circle-check" tone="ok">
      {text}
      {when && <span className={a.when}>{` · ${when}`}</span>}
    </Line>
  ) : (
    <Line icon="alert" tone="warn">{when ? `${text} · ${when}` : text}</Line>
  );
}

/** The grain: a sentence saved on blur or Enter. What it shows after a save is what the server kept (trimmed). */
function GrainField({ saved, placeholder, problem, onSave }: { saved: string; placeholder: string; problem?: string; onSave: (v: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  /** The text last sent: Enter and the blur after it are one save, and a refused one is not sent again until the field is come back to. */
  const sent = useRef<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next === saved) {
      sent.current = null;
      return setDraft(null);
    }
    if (next === sent.current) return;
    sent.current = next;
    void onSave(next).then((ok) => {
      if (!ok) return;
      sent.current = null;
      setDraft((cur) => (cur !== null && cur.trim() === next ? null : cur)); // not over what was typed while it saved
    });
  };
  return (
    <Input
      label="Grain"
      hint="What one row is, in a sentence. The Assistant uses it to word its answers."
      error={problem}
      value={draft ?? saved}
      placeholder={placeholder}
      maxLength={MAX_GRAIN}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => (sent.current = null)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())}
    />
  );
}

/** The guide: markdown, read as rendered text, written in its own editor (a long text is saved on purpose, not on blur). */
function Guide({ guide, canEdit, problem, onSave }: { guide: string; canEdit: boolean; problem?: string; onSave: (v: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const start = () => {
    setDraft(guide);
    setEditing(true);
  };
  const save = async () => {
    if (draft.trim() === guide) return setEditing(false);
    setSaving(true);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) setEditing(false);
  };
  // Nothing written and nobody writing: the empty state is the whole card (it has a frame of its own).
  if (!guide && !editing) {
    return (
      <EmptyState
        icon="file-text"
        heading={3}
        title="No guide yet"
        actions={
          canEdit && (
            <Button variant="primary" icon="pencil" onClick={start}>
              Write a guide
            </Button>
          )
        }
      >
        {canEdit
          ? 'Write what a teammate or the Assistant should know before using this table: what it holds, what to filter on, what to watch for.'
          : 'Nobody has written a guide for this table.'}
      </EmptyState>
    );
  }
  return (
    <div className={a.card}>
      <div className={a.guideHead}>
        <h3 className={a.guideTitle}>Guide</h3>
        {canEdit && !editing && (
          <Button size="sm" icon="pencil" onClick={start}>
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <div className={a.editor}>
          <Textarea
            className={a.guideInput}
            aria-label="Guide"
            hint={`Markdown: headings, lists, links and code. Up to ${formatNumber(MAX_GUIDE)} characters.`}
            error={problem}
            rows={14}
            maxLength={MAX_GUIDE}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
            }}
          />
          <div className={a.editorBar}>
            <Button onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save guide
            </Button>
          </div>
        </div>
      ) : (
        <div className={a.guideBody}>
          <MarkdownView text={guide} token={keepToken} />
        </div>
      )}
    </div>
  );
}

function Notes({ projectId, datasetId, header, live, table, canEdit }: { projectId: string; datasetId: string; header: DatasetColumns; live: boolean; table: TableDoc; canEdit: boolean }) {
  const writes = useTableWrites(projectId, datasetId);
  /** What was just picked or sent and is not answered yet: shown at once, dropped when the server has said. */
  const [sent, setSent] = useState<TablePatch>({});
  const [problems, setProblems] = useState<Partial<Record<Slot, string>>>({});
  const [checkFailed, setCheckFailed] = useState<Extract<TableReply, { ok: false }> | null>(null);

  const save = async (slot: Slot, patch: TablePatch): Promise<boolean> => {
    setSent((p) => ({ ...p, ...patch }));
    setProblems((p) => ({ ...p, [slot]: undefined }));
    let ok = false;
    try {
      const r = await writes.save.mutateAsync({ projectId, datasetId, patch });
      ok = r.ok;
      if (!r.ok) setProblems((p) => ({ ...p, [slot]: r.error || 'This could not be saved.' }));
    } catch {
      // the write's own toast says it did not go through
    }
    setSent((p) => {
      const rest = { ...p };
      delete rest[slot];
      return rest;
    });
    return ok;
  };
  const check = () => {
    setCheckFailed(null);
    void writes.check.mutateAsync({ projectId, datasetId }).then((r) => !r.ok && setCheckFailed(r), () => undefined);
  };

  const columns = header.columns.map((c) => c.name);
  const key = sent.key ?? table.key;
  const known = columns.includes(key);
  // A key just picked is not yet the one the stored count belongs to.
  const shown: TableDoc = sent.key === undefined ? table : { ...table, key: sent.key, keyCheck: undefined };
  const counting = !!sent.key && !live; // a new key on an extract is counted before the server replies
  const scoped = header.scoped === true;
  const blank = !table.role && !table.key && !table.grain && !table.guide;

  if (!canEdit && blank) {
    return (
      <EmptyState icon="info" heading={3} title="Nothing written about this table yet">
        An editor of this project can say what one row is, which column is its key, and add a guide.
      </EmptyState>
    );
  }
  const keyOptions = [...(table.key ? [{ value: '', label: 'No key' }] : []), ...columns.map((name) => ({ value: name, label: name }))];
  const verdict = counting ? (
    <p className={a.line} role="status" aria-busy="true">
      <Icon name="refresh" size={16} />
      <span className={a.sentence}>{`Counting ${key}…`}</span>
    </p>
  ) : key ? (
    <KeyLine table={shown} known={known} scoped={scoped} />
  ) : null;

  return (
    <div className={a.layout}>
      <div className={a.card}>
        {canEdit ? (
          <>
            <div className={a.field}>
              <RadioGroup
                label="Role"
                value={sent.role ?? table.role}
                options={ROLES}
                error={problems.role}
                onValueChange={(v) => void save('role', { role: v as TableDoc['role'] })}
              />
            </div>
            <div className={a.field}>
              <Select
                label="Key"
                hint={
                  live
                    ? 'The column that names one row. Counted in the warehouse only when you press Check now.'
                    : 'The column that names one row. Relationships into this table should look rows up by it.'
                }
                error={problems.key}
                placeholder="Pick the key column"
                value={known ? key : null}
                options={keyOptions}
                onValueChange={(v) => v !== table.key && void save('key', { key: v })}
              />
              {key && (
                <div className={a.keyStatus}>
                  {verdict}
                  <Button size="sm" icon="refresh" loading={writes.check.isPending} disabled={!known || counting} onClick={check}>
                    Check now
                  </Button>
                </div>
              )}
              {checkFailed &&
                (liveRefusalOf(checkFailed) !== null ? (
                  <LiveRefusal refusal={checkFailed} projectId={projectId} datasetId={datasetId} liveTitle="The key was not counted" />
                ) : (
                  <p className={s.rowError} role="alert">
                    {checkFailed.error || 'The key could not be counted.'}
                  </p>
                ))}
            </div>
            <div className={a.field}>
              <GrainField
                saved={table.grain}
                placeholder={key ? `One row per ${key}` : 'For example, one row per order line'}
                problem={problems.grain}
                onSave={(grain) => save('grain', { grain })}
              />
            </div>
          </>
        ) : (
          <dl className={a.facts}>
            <div>
              <dt>Role</dt>
              <dd className={table.role ? undefined : a.unsaid}>{roleWord(table.role)}</dd>
            </div>
            <div>
              <dt>Key</dt>
              <dd>{verdict ?? <span className={a.unsaid}>Not said</span>}</dd>
            </div>
            <div>
              <dt>Grain</dt>
              <dd className={table.grain ? undefined : a.unsaid}>{table.grain || 'Not said'}</dd>
            </div>
          </dl>
        )}
      </div>
      <Guide guide={table.guide} canEdit={canEdit} problem={problems.guide} onSave={(guide) => save('guide', { guide })} />
    </div>
  );
}

function Loading() {
  return (
    <div className={a.layout} role="status" aria-busy="true" aria-label="Loading the table notes">
      {[3, 5].map((rows, i) => (
        <div key={i} className={a.card} aria-hidden="true">
          <div className={a.skRows}>
            <Skeleton className={a.skLabel} />
            {Array.from({ length: rows }, (_, r) => (
              <Skeleton key={r} className={r === 0 && i === 0 ? a.skControl : a.skLine} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AboutTab({ projectId, datasetId, header, live = false }: { projectId: string; datasetId: string; header: DatasetColumns; live?: boolean }) {
  const doc = useTableDoc(projectId, datasetId);
  // The notes are an editor's to change; a viewer reads them (false until the roles are known).
  const canEdit = useCanEdit(projectId);
  return (
    <section className={s.section} aria-label="About this table">
      <p className={s.lead}>Say what one row of this dataset is and how to use it. The Assistant and MCP clients read these notes along with the data.</p>
      {doc.isPending ? (
        <Loading />
      ) : doc.isError ? (
        <ErrorState heading={3} title="The table notes could not be loaded" message={doc.error.message} onRetry={() => void doc.refetch()} />
      ) : (
        <>
          <Notes projectId={projectId} datasetId={datasetId} header={header} live={live} table={doc.data} canEdit={canEdit} />
          {doc.data.updatedAt && <p className={s.stamp}>{`Updated by ${doc.data.updatedBy || 'someone'} · ${ago(doc.data.updatedAt)}`}</p>}
        </>
      )}
    </section>
  );
}
