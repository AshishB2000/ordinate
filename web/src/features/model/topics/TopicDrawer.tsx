// The topic drawer (semantic layer part 6, D14–D15): a topic's name and description, its datasets (picked ones first,
// in the topic's order, each with its fields), its metrics and its terms. It opens on `topic:get`'s `kept` — the topic
// without what has gone — says how many went, and saves that. A save goes through the edit-conflict guard; a 409 shows
// the house banner and the drawer stays. A topic is never access control, and the drawer says so in those words.

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { useDatasets } from '../../../api/datasets';
import { Button, IconButton } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { ConfirmDelete } from '../../../ui/ConfirmDelete';
import { DialogClose, Drawer } from '../../../ui/Dialog';
import { Input, Textarea } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonRows } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { failure } from '../../analyses/api';
import { useMetricList } from '../../analyses/metrics/api';
import { ConflictBanner } from '../../editConflicts/ConflictBanner';
import { useEditGuard } from '../../editConflicts/useEditGuard';
import { formatNumber } from '../../data/format';
import { toastMovedToTrash } from '../../projects/trashToast';
import { NAVIGATION } from '../navigation';
import { useTerms } from '../terms/api';
import { MAX_DATASETS, useTopic, type NavTopic, type SaveReply, type TopicField } from './api';
import { FieldSubset } from './FieldSubset';
import s from './Topics.module.css';

type Props = { projectId: string; id?: string; onClose: () => void; onSaved?: (id: string) => void; onDeleted?: () => void };
type Errors = Partial<Record<TopicField | 'form', string>>;

const NOTE = "Topics tidy what people see first. They don't limit access: anyone who can open this project can still reach every dataset. Use project sharing or row access rules for that.";

/** The drawer, and its Reload after a conflict: the topic read again, in a new form. */
export function TopicDrawer(props: Props) {
  const q = useTopic(props.projectId, props.id);
  const [gen, setGen] = useState(0);
  return <TopicForm key={gen} {...props} query={q} onReload={() => void q.refetch().then(() => setGen((g) => g + 1))} />;
}

function TopicForm({ projectId, id, onClose, onSaved, onDeleted, query, onReload }: Props & { query: ReturnType<typeof useTopic>; onReload: () => void }) {
  const client = useQueryClient();
  const opened = query.data;
  const start: NavTopic | undefined = opened?.kept;
  const guard = useEditGuard({ projectId, type: 'topic', id }, opened?.tag);
  const sets = useDatasets(projectId);
  const metrics = useMetricList(projectId);
  const terms = useTerms(projectId);
  const [name, setName] = useState(start?.name ?? '');
  const [description, setDescription] = useState(start?.description ?? '');
  const [picked, setPicked] = useState(start?.datasets ?? []);
  const [metricIds, setMetricIds] = useState(start?.metricIds ?? []);
  const [termIds, setTermIds] = useState(start?.termIds ?? []);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  // An edit opens before `topic:get` lands: the same drawer fills in when it does, once.
  const [ready, setReady] = useState(!id || !!opened);
  useEffect(() => {
    if (ready || !opened) return;
    setName(opened.kept.name);
    setDescription(opened.kept.description ?? '');
    setPicked(opened.kept.datasets);
    setMetricIds(opened.kept.metricIds);
    setTermIds(opened.kept.termIds);
    setReady(true);
  }, [opened, ready]);

  const draft = (n: string) => ({ name: n, ...(description.trim() ? { description: description.trim() } : {}), datasets: picked, metricIds, termIds });
  const send = (topic: ReturnType<typeof draft>, saveId?: string) => (base?: string) =>
    rpc('topic:save', { projectId, ...(saveId ? { id: saveId } : {}), ...(base ? { base } : {}), topic }) as Promise<SaveReply>;
  const landed = (r: SaveReply & { ok: true }) => {
    void client.invalidateQueries({ queryKey: [NAVIGATION, projectId] });
    onSaved?.(r.topic.id);
    onClose();
  };
  const save = async () => {
    setErrors({});
    const n = name.trim();
    if (!n) return setErrors({ name: 'A topic needs a name.' });
    setSaving(true);
    try {
      const r = id ? await guard.save(send(draft(n), id)) : await send(draft(n))();
      if (r === null) return; // the conflict banner
      if (r.ok) landed(r);
      else setErrors({ [r.field ?? 'form']: r.error });
    } catch (err) {
      setErrors({ form: failure(err, 'The topic could not be saved.') });
    } finally {
      setSaving(false);
    }
  };
  // The banner's "Save mine as a copy": this drawer's topic as a new one.
  const copy = async () => {
    const r = await send(draft(`${name.trim() || 'Topic'} (copy)`.slice(0, 80)))();
    if (!r.ok) throw new Error(r.error);
    landed(r);
  };
  const remove = async () => {
    setAsking(false);
    const reply = (await rpc('topic:delete', { projectId, id: id ?? '' }).catch(() => null)) as { ok?: boolean } | null;
    toastMovedToTrash(client, { projectId, type: 'topic', id: id ?? '', name: start?.name ?? name }, reply);
    void client.invalidateQueries({ queryKey: [NAVIGATION, projectId] });
    if (reply?.ok) {
      onDeleted?.();
      onClose();
    }
  };

  const stale = opened?.stale ?? 0;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={id ? (start ? `Topic · ${start.name}` : 'Topic') : 'New topic'}
      footer={
        <>
          {id && (
            <Button variant="ghost" icon="trash" className={s.deleteBtn} disabled={!ready} onClick={() => setAsking(true)}>
              Delete
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={saving} disabled={guard.changed || !ready} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {guard.changed && <ConflictBanner compact noun="topic" onReload={onReload} onCopy={copy} />}
      {!ready ? (
        query.isError ? (
          <ErrorState heading={3} title="The topic could not be opened" message={query.error.message} onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonRows rows={6} label="Loading the topic" />
        )
      ) : (
        <div className={s.form}>
          <p className={s.note}>
            <Icon name="info" size={16} />
            <span>{NOTE}</span>
          </p>
          {stale > 0 && (
            <p className={s.stale} role="status">
              <Icon name="alert" size={16} />
              <span>{stale === 1 ? '1 item no longer exists. Saving removes it.' : `${formatNumber(stale)} items no longer exist. Saving removes them.`}</span>
            </p>
          )}
          <Input label="Name" placeholder="Sales" value={name} error={errors.name} onChange={(e) => setName(e.target.value)} autoFocus={!id} maxLength={80} />
          <Textarea label="Description" placeholder="Who it is for and what they look at first" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          <Datasets projectId={projectId} sets={sets} picked={picked} onChange={setPicked} error={errors.datasets} />
          <Members title="Metrics" icon="target" query={metrics} empty="This project has no metrics yet." ids={metricIds} onChange={setMetricIds} error={errors.metricIds} />
          <Members title="Terms" icon="list" query={terms} empty="This project has no glossary terms yet." ids={termIds} onChange={setTermIds} error={errors.termIds} />
          {errors.form && (
            <p className={s.error} role="alert">
              {errors.form}
            </p>
          )}
        </div>
      )}
      {asking && (
        <ConfirmDelete
          title={`Delete “${start?.name ?? name}”?`}
          description="It moves to the Trash for 30 days. Nothing else changes: its datasets, metrics and terms stay as they are."
          onConfirm={() => void remove()}
          onClose={() => setAsking(false)}
        />
      )}
    </Drawer>
  );
}

type Picked = NavTopic['datasets'];

function Datasets({ projectId, sets, picked, onChange, error }: { projectId: string; sets: ReturnType<typeof useDatasets>; picked: Picked; onChange: (p: Picked) => void; error?: string }) {
  const fullId = 'topic-datasets-full';
  const all = sets.data ?? [];
  const byId = new Map(all.map((d) => [d.id, d]));
  const chosen = picked.filter((p) => byId.has(p.id));
  const rest = all.filter((d) => !picked.some((p) => p.id === d.id));
  const full = picked.length >= MAX_DATASETS;
  const move = (i: number, by: -1 | 1) => {
    const next = [...picked];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return (
    <fieldset className={s.group}>
      <legend className={s.legend}>
        <Icon name="database" size={16} />
        Datasets
      </legend>
      <p className={s.hint}>Pick up to {MAX_DATASETS}, in the order people should see them.</p>
      {sets.isPending ? (
        <SkeletonRows rows={3} label="Loading the datasets" />
      ) : sets.isError ? (
        <p className={s.error}>The datasets could not be listed: {sets.error.message}</p>
      ) : !all.length ? (
        <p className={s.muted}>This project has no datasets yet.</p>
      ) : (
        <>
          {chosen.length > 0 && (
            <ol className={s.ordered} aria-label="Datasets in this topic">
              {chosen.map((p, i) => {
                const d = byId.get(p.id)!;
                return (
                  <li key={p.id} className={s.orderedRow}>
                    <span className={s.rank} aria-hidden="true">
                      {i + 1}
                    </span>
                    <Checkbox className={s.grow} label={d.name || 'Untitled dataset'} checked onCheckedChange={() => onChange(picked.filter((x) => x.id !== p.id))} />
                    <FieldSubset
                      projectId={projectId}
                      datasetId={p.id}
                      name={d.name || 'Untitled dataset'}
                      total={d.columnCount}
                      fields={p.fields}
                      onChange={(fields) => onChange(picked.map((x) => (x.id === p.id ? (fields ? { id: p.id, fields } : { id: p.id }) : x)))}
                    />
                    <IconButton icon="arrow-up" size="sm" label={`Move ${d.name} up`} disabled={i === 0} onClick={() => move(picked.indexOf(p), -1)} />
                    <IconButton icon="arrow-down" size="sm" label={`Move ${d.name} down`} disabled={i === chosen.length - 1} onClick={() => move(picked.indexOf(p), 1)} />
                  </li>
                );
              })}
            </ol>
          )}
          {full && rest.length > 0 && (
            <p className={s.hint} id={fullId}>
              A topic holds at most {MAX_DATASETS} datasets.
            </p>
          )}
          {rest.length > 0 && (
            <div className={s.pool}>
              {rest.map((d) => (
                <Checkbox
                  key={d.id}
                  label={d.name || 'Untitled dataset'}
                  checked={false}
                  disabled={full}
                  aria-describedby={full ? fullId : undefined}
                  onCheckedChange={() => onChange([...picked, { id: d.id }])}
                />
              ))}
            </div>
          )}
        </>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

type ListQuery = { isPending: boolean; isError: boolean; data?: { id: string; name: string }[] };

function Members({ title, icon, query, empty, ids, onChange, error }: {
  title: string;
  icon: 'target' | 'list';
  query: ListQuery;
  empty: string;
  ids: string[];
  onChange: (ids: string[]) => void;
  error?: string;
}) {
  const items = query.data ?? [];
  return (
    <fieldset className={s.group}>
      <legend className={s.legend}>
        <Icon name={icon} size={16} />
        {title}
      </legend>
      {query.isPending ? (
        <SkeletonRows rows={2} label={`Loading the ${title.toLowerCase()}`} />
      ) : query.isError ? (
        <p className={s.error}>The {title.toLowerCase()} could not be listed. Close this and try again.</p>
      ) : !items.length ? (
        <p className={s.muted}>{empty}</p>
      ) : (
        <div className={s.pool}>
          {items.map((m) => (
            <Checkbox key={m.id} label={m.name} checked={ids.includes(m.id)} onCheckedChange={(v) => onChange(v ? [...ids, m.id] : ids.filter((x) => x !== m.id))} />
          ))}
        </div>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
