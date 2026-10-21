// The dataset page's Row access tab (docs/row-policy/00-design.md, UI) — a
// project ADMIN's: which rows each user or team may see when their role is
// Viewer. The server enforces the rules on every read; this tab only edits them
// (`dataset:rowPolicy` / `dataset:setRowPolicy`, both admin channels). The page
// shows the tab to admins only — hidden, never disabled, for everyone else.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { DatasetColumns } from '../../api/datasets';
import { Button, IconButton } from '../../ui/Button';
import { Combobox } from '../../ui/Combobox';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useDistinct } from '../analyses/editor/ValuePicker';
import { useShareTargets } from '../projects/api';
import { useRowPolicy, useSaveRowPolicy, type RowRule, type RuleState } from './rowAccessApi';
import s from './RowAccess.module.css';

/** A rule as the editor holds it: a member key (`user:<id>` / `team:<id>`) and its values. */
interface Draft {
  key: number;
  member: string | null;
  values: string[];
}

const WARN: Record<Exclude<RuleState, 'ok'>, string> = {
  column: 'The rule column is gone or is no longer text, so viewers see no rows until you pick another column.',
  pipeline: 'This dataset stores values computed across rows (a running total, a rank, a segment, a level-of-detail field, a query over other datasets), so viewers are refused: those values were computed over every row.',
  writers: 'A prepare step that writes the rule column changed since these rules were saved, so viewers are refused. Check the step, then save the rules again.',
};

const toDraft = (rules: RowRule[]): Draft[] => rules.map((r, i) => ({ key: i, member: 'userId' in r ? `user:${r.userId}` : `team:${r.teamId}`, values: [...r.values] }));

/** One rule's values: the picked ones as chips, a search of the column's values, and any value typed. */
function ValuesField({ projectId, datasetId, column, values, onChange }: { projectId: string; datasetId: string; column: string; values: string[]; onChange: (v: string[]) => void }) {
  const [typed, setTyped] = useState('');
  const list = useDistinct(projectId, datasetId, column);
  const options = (list.data?.values ?? []).filter((v) => !values.includes(v)).map((v) => ({ value: v, label: v }));
  const add = (v: string) => {
    if (v.trim() !== '' && !values.includes(v)) onChange([...values, v]);
  };
  return (
    <div className={s.values}>
      <ul className={s.chips} aria-label="Values this member sees">
        {values.map((v) => (
          <li key={v} className={s.chip}>
            <span>{v}</span>
            <IconButton icon="x" size="sm" label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} />
          </li>
        ))}
        {!values.length && <li className={s.none}>No values yet: this member would see no rows.</li>}
      </ul>
      <div className={s.adders}>
        <Combobox aria-label="Add a value from the column" placeholder={list.isPending ? 'Loading values…' : 'Search the column’s values'} value={null} onValueChange={add} options={options} emptyText="No more values" disabled={!column} />
        <form className={s.typed} onSubmit={(e) => { e.preventDefault(); add(typed); setTyped(''); }}>
          <Input aria-label="Type a value" placeholder="Or type one" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <Button type="submit" size="sm" disabled={typed.trim() === ''}>Add</Button>
        </form>
      </div>
    </div>
  );
}

export function RowAccessTab({ projectId, datasetId, header }: { projectId: string; datasetId: string; header: DatasetColumns }) {
  const q = useRowPolicy(projectId, datasetId, true);
  const targets = useShareTargets(projectId, true);
  const save = useSaveRowPolicy(projectId, datasetId);
  const [editing, setEditing] = useState<{ column: string; rules: Draft[] } | null>(null);
  const [removing, setRemoving] = useState(false);
  const texts = header.columns.filter((c) => c.type === 'text').map((c) => ({ value: c.name, label: c.name }));
  const members = useMemo(() => [
    ...(targets.data?.teams ?? []).map((t) => ({ value: `team:${t.id}`, label: `${t.name} (team)` })),
    ...(targets.data?.users ?? []).map((u) => ({ value: `user:${u.id}`, label: u.email })),
  ], [targets.data]);

  if (q.isPending) return <SkeletonRows rows={4} label="Loading the row access rules" />;
  if (q.isError) return <ErrorState heading={3} title="The row access rules could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  const reply = q.data;
  if (!reply.ok) {
    return <EmptyState heading={3} icon="lock" title="Row access is not available on this server">{reply.error}</EmptyState>;
  }

  const saved = reply.policy;
  const draft = editing ?? (saved ? { column: saved.column, rules: toDraft(saved.rules) } : null);
  const edit = (next: { column: string; rules: Draft[] }) => setEditing(next);
  const submit = () => {
    if (!draft) return;
    const rules: RowRule[] = [];
    for (const r of draft.rules) {
      if (!r.member) continue;
      const [kind, id] = r.member.split(':') as ['user' | 'team', string];
      rules.push(kind === 'user' ? { userId: id, values: r.values } : { teamId: id, values: r.values });
    }
    save.mutate({ column: draft.column, rules }, {
      onSuccess: (res) => {
        if (res.ok) {
          setEditing(null);
          toast('Row access rules saved.', { kind: 'success' });
        } else toast(res.error, { kind: 'error' });
      },
    });
  };

  const summary = (
    <aside className={s.summary} aria-label="Who sees what">
      <h3 className={s.sumTitle}>Who sees what</h3>
      <ul className={s.sumList}>
        <li><Icon name="shield" size={16} />Editors and admins see every row.</li>
        <li><Icon name="user" size={16} />Viewers see only the rows their rules give them; a viewer with no rule sees none.</li>
        <li><Icon name="lock" size={16} />While rules are on, published links, embeds, subscriptions and alerts that read this dataset are off.</li>
      </ul>
      {reply.builtFrom.length > 0 && (
        <>
          <h3 className={s.sumTitle}>Built from this dataset</h3>
          <p className={s.sumNote}>Closed to viewers until each has rules of its own.</p>
          <ul className={s.built}>
            {reply.builtFrom.map((d) => (
              <li key={d.id}><Link to={`/data/${projectId}/${d.id}?tab=access`}>{d.name}</Link></li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );

  if (!draft) {
    return (
      <div className={s.layout}>
        <EmptyState
          heading={3}
          icon="lock"
          title="No row access rules"
          actions={<Button variant="primary" icon="plus" disabled={!texts.length} onClick={() => edit({ column: texts[0]?.value ?? '', rules: [{ key: 0, member: null, values: [] }] })}>Add rules</Button>}
        >
          {texts.length ? 'Everyone with access to this project sees every row.' : 'Rules need a text column, and this dataset has none.'}
        </EmptyState>
        {summary}
      </div>
    );
  }

  const setRule = (key: number, patch: Partial<Draft>) => edit({ ...draft, rules: draft.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const complete = draft.column !== '' && draft.rules.length > 0 && draft.rules.every((r) => r.member && r.values.length > 0);
  return (
    <div className={s.layout}>
      <section className={s.editor} aria-label="Row access rules">
        {saved && reply.state !== 'ok' && !editing && (
          <p className={s.warn} role="status"><Icon name="alert" size={16} />{WARN[reply.state]}</p>
        )}
        <Select label="Rule column" hint="Rows are matched on this column’s exact values." value={draft.column} options={texts} onValueChange={(column) => edit({ column, rules: draft.rules.map((r) => ({ ...r, values: [] })) })} />
        {targets.isError && <ErrorState compact heading={3} title="The org’s people could not be loaded" message={targets.error.message} />}
        <ol className={s.rules}>
          {draft.rules.map((r) => (
            <li key={r.key} className={s.rule}>
              <div className={s.ruleHead}>
                <Combobox label="Who" placeholder={targets.isPending ? 'Loading…' : 'Search people and teams'} value={r.member} onValueChange={(member) => setRule(r.key, { member })} options={members} disabled={targets.isPending} />
                <IconButton icon="trash" label="Remove this rule" onClick={() => edit({ ...draft, rules: draft.rules.filter((x) => x.key !== r.key) })} />
              </div>
              <ValuesField projectId={projectId} datasetId={datasetId} column={draft.column} values={r.values} onChange={(values) => setRule(r.key, { values })} />
            </li>
          ))}
        </ol>
        <div className={s.actions}>
          <Button icon="plus" onClick={() => edit({ ...draft, rules: [...draft.rules, { key: Math.max(-1, ...draft.rules.map((x) => x.key)) + 1, member: null, values: [] }] })}>Add a rule</Button>
          <span className={s.grow} />
          {saved && <Button variant="danger" onClick={() => setRemoving(true)}>Remove all rules</Button>}
          {editing && <Button onClick={() => setEditing(null)}>Cancel</Button>}
          <Button variant="primary" disabled={!complete || !editing} loading={save.isPending} onClick={submit}>Save</Button>
        </div>
      </section>
      {summary}
      {removing && (
        <Dialog
          open
          onOpenChange={(o) => !o && setRemoving(false)}
          title="Remove all row access rules?"
          description="Every viewer of the project will see every row of this dataset."
          footer={
            <>
              <DialogClose asChild><Button>Cancel</Button></DialogClose>
              <Button variant="danger" loading={save.isPending} onClick={() => save.mutate(null, { onSuccess: () => { setRemoving(false); setEditing(null); } })}>Remove rules</Button>
            </>
          }
        />
      )}
    </div>
  );
}
