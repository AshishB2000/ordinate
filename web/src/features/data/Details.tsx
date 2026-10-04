// The "Details" popovers (catalogDetails.ts): description, tags and owner for a
// record; display name, description, example and sensitivity for a column.
// No Save button — a field saves on blur and on Enter, and closing the
// popover commits whatever was being typed. The server stamps who and when.

import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import { Input, Textarea } from '../../ui/Field';
import { Popover } from '../../ui/Popover';
import { RadioGroup } from '../../ui/Choice';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { useQuery } from '@tanstack/react-query';
import { call, useTags, useWrite, type ColumnDoc, type Doc } from './api';
import { ago } from './format';
import { TagEditor } from './tags';
import s from './Data.module.css';

const KIND_WORD: Record<string, string> = {
  dataset: 'Dataset', visual: 'Visual', analysis: 'Dashboard', metric: 'Metric', report: 'Report', story: 'Story',
};

/** "Updated by ana@acme · 3m ago", or an honest "Not documented yet". */
function Stamp({ by, at }: { by?: string; at?: string }) {
  return (
    <p className={s.stamp}>
      {at ? `Updated by ${by || 'someone'} · ${ago(at)}` : 'Not documented yet — anything you add here is shown to everyone in this project.'}
    </p>
  );
}

/** Text that commits on blur and on Enter (Shift+Enter is a newline in a textarea); `pending` holds what is typed. */
function useCommitText(saved: string, commit: (v: string) => void) {
  const [v, setV] = useState(saved);
  const last = useRef(saved);
  const flush = () => {
    const next = v.trim();
    if (next === last.current) return;
    last.current = next;
    commit(next);
  };
  return { v, setV, flush };
}

function RecordFields({ projectId, ref_, doc, flushRef }: { projectId: string; ref_: string; doc: Doc; flushRef: RefObject<() => void> }) {
  const tags = useTags(projectId);
  const [stamp, setStamp] = useState<{ by?: string; at?: string }>({ by: doc.updatedBy, at: doc.updatedAt });
  const [tagList, setTagList] = useState(doc.tags.map((t) => t.name));
  const save = useWrite('catalog:set', ['catalog:list', 'catalog:tags', 'catalog:get'], {
    onDone: (r: { ok?: boolean; doc?: Doc }) => r.ok && r.doc && setStamp({ by: r.doc.updatedBy, at: r.doc.updatedAt }),
  });
  const desc = useCommitText(doc.description, (description) => save.mutate({ projectId, ref: ref_, patch: { description } }));
  const owner = useCommitText(doc.owner, (o) => save.mutate({ projectId, ref: ref_, patch: { owner: o } }));
  // Closing the popover is the blur: a removed field does not reliably fire one.
  useEffect(() => {
    flushRef.current = () => {
      desc.flush();
      owner.flush();
    };
  });
  return (
    <div className={s.popFields}>
      <Textarea
        label="Description"
        rows={3}
        value={desc.v}
        placeholder="What is this, and when should someone use it?"
        onChange={(e) => desc.setV(e.target.value)}
        onBlur={desc.flush}
        onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), desc.flush())}
        autoFocus
      />
      <div className={s.popField}>
        <span className={s.popLabel}>Tags</span>
        <TagEditor
          value={tagList}
          index={tags.data}
          onChange={(next) => {
            setTagList(next);
            save.mutate({ projectId, ref: ref_, patch: { tags: next } });
          }}
        />
      </div>
      <Input
        label="Owner"
        value={owner.v}
        placeholder="Who to ask about this"
        onChange={(e) => owner.setV(e.target.value)}
        onBlur={owner.flush}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), owner.flush())}
      />
      <Stamp by={stamp.by} at={stamp.at} />
    </div>
  );
}

/** A record's Details popover on `trigger`. */
export function RecordDetails({ projectId, kind, id, name, trigger }: { projectId: string; kind: string; id: string; name: string; trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  const ref_ = `${kind}:${id}`;
  const flushRef = useRef<() => void>(() => {});
  const q = useQuery({
    queryKey: ['catalog:get', projectId, ref_],
    queryFn: async () => {
      const r = (await call('catalog:get', { projectId, ref: ref_ })) as { ok: true; doc: Doc } | { ok: false; error: string };
      if (!r.ok) throw new Error(r.error);
      return r.doc;
    },
    enabled: open,
  });
  return (
    <Popover
      title={`${KIND_WORD[kind] ?? 'Record'} details`}
      open={open}
      onOpenChange={(o) => {
        if (!o) flushRef.current();
        setOpen(o);
      }}
      align="end"
      trigger={trigger}
    >
      <div className={s.popHead}>
        <span className={s.popKicker}>{KIND_WORD[kind] ?? 'Record'} details</span>
        <span className={s.popName}>{name}</span>
      </div>
      {q.isPending ? (
        <SkeletonRows rows={3} label="Loading the details" />
      ) : q.isError ? (
        <ErrorState compact heading={3} title="Could not read the details" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <RecordFields projectId={projectId} ref_={ref_} doc={q.data} flushRef={flushRef} />
      )}
    </Popover>
  );
}

export const SENSITIVITY = [
  { value: 'none', label: 'None', hint: 'Nothing sensitive' },
  { value: 'personal', label: 'Personal', hint: 'Identifies a person: names, emails, phone numbers, addresses' },
  { value: 'financial', label: 'Financial', hint: 'Money a person or the business would not share: salaries, margins, account numbers' },
] as const;

/** A column's notes, in a popover (the profile panel's ⓘ). `example` is a typical value the app read. */
export function ColumnDetails({ projectId, datasetId, column, doc, example, trigger }: {
  projectId: string;
  datasetId: string;
  column: string;
  doc: ColumnDoc;
  example?: string;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const save = useWrite('catalog:setColumn', ['catalog:columns']);
  const patch = (p: Pick<ColumnDoc, 'displayName' | 'description' | 'example' | 'sensitivity'>) => save.mutate({ projectId, datasetId, column, patch: p });
  const display = useCommitText(doc.displayName ?? '', (displayName) => patch({ displayName }));
  const desc = useCommitText(doc.description ?? '', (description) => patch({ description }));
  const ex = useCommitText(doc.example ?? '', (e) => patch({ example: e }));
  return (
    <Popover
      title={`Details for column ${column}`}
      open={open}
      onOpenChange={(o) => {
        if (!o) [display, desc, ex].forEach((f) => f.flush());
        setOpen(o);
      }}
      align="end"
      trigger={trigger}
    >
      <div className={s.popHead}>
        <span className={s.popKicker}>Column details</span>
        <span className={s.popName}>{column}</span>
      </div>
      <div className={s.popFields}>
        <Input label="Display name" value={display.v} placeholder={column} autoFocus onChange={(e) => display.setV(e.target.value)} onBlur={display.flush} />
        <Textarea label="Description" rows={3} value={desc.v} placeholder="What does one value in this column mean?" onChange={(e) => desc.setV(e.target.value)} onBlur={desc.flush} />
        <Input label="Example" value={ex.v} placeholder={example || 'A typical value'} onChange={(e) => ex.setV(e.target.value)} onBlur={ex.flush} />
        <RadioGroup
          label="Sensitivity"
          orientation="horizontal"
          value={doc.sensitivity ?? 'none'}
          options={SENSITIVITY}
          onValueChange={(v) => patch({ sensitivity: v as ColumnDoc['sensitivity'] })}
        />
        <Stamp by={doc.updatedBy} at={doc.updatedAt} />
      </div>
    </Popover>
  );
}
