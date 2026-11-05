// Who sees each column (semantic layer part 4, step 07; docs/semantic-layer/04-governance.md D12–D14, D22) —
// the second half of a dataset's Access tab, a project ADMIN's. A rule is an allow-list: the members it names
// see the column's values, and every figure computed from it; every other viewer does not (its name still
// shows). The server adds the columns computed from a hidden one (carriers, listed read-only) and enforces it
// all; this section only edits the admin's own rules (`dataset:columnAccess` / `dataset:setColumnAccess`).

import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { DatasetColumns } from '../../api/datasets';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useColumnAccess, useSaveColumnAccess, type ColumnRule } from './columnAccessApi';
import { MemberPicker, useMembers } from './MemberPicker';
import type { RuleMember } from './rowAccessApi';
import r from './RowAccess.module.css';
import s from './ColumnAccess.module.css';

type Own = { column: string; visibleTo: RuleMember[] };
const own = (rules: ColumnRule[]): Own[] => rules.filter((x) => x.from === undefined).map((x) => ({ column: x.column, visibleTo: x.visibleTo }));
const either = (names: string[], one: string, many: string) => (names.length === 1 ? `${names[0]} ${one}` : `${names.join(', ')} ${many}`);

/** Add or edit one rule: the column (new rules only) and who sees it. A refusal is the server's sentence, here. */
function RuleDialog({ projectId, column, free, initial, onSave, onClose }: {
  projectId: string;
  column: string | null;
  free: string[];
  initial: RuleMember[];
  onSave: (column: string, visibleTo: RuleMember[], done: (error?: string) => void) => void;
  onClose: () => void;
}) {
  const [col, setCol] = useState(column ?? '');
  const [who, setWho] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = () => {
    setBusy(true);
    onSave(col, who, (e) => {
      setBusy(false);
      if (e) setError(e);
      else onClose();
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={column ? `Who sees ${column}` : 'Hide a column'}
      description="Viewers not named here don't get its values, or any figure computed from it. Its name still shows. Editors and admins see every column."
      footer={
        <>
          <DialogClose asChild><Button>Cancel</Button></DialogClose>
          <Button variant="primary" disabled={!col} loading={busy} onClick={submit}>Save</Button>
        </>
      }
    >
      <div className={s.form}>
        {!column && <Select label="Column" placeholder="Pick a column" value={col} options={free.map((c) => ({ value: c, label: c }))} onValueChange={setCol} />}
        <div className={s.field}>
          <span className={s.fieldLabel}>Who can see it</span>
          <MemberPicker projectId={projectId} value={who} onChange={setWho} />
        </div>
        {error && <p className={s.error} role="alert"><Icon name="alert" size={16} />{error}</p>}
      </div>
    </Dialog>
  );
}

export function ColumnAccessSection({ projectId, datasetId, header }: { projectId: string; datasetId: string; header: DatasetColumns }) {
  const titleId = useId();
  const q = useColumnAccess(projectId, datasetId);
  const save = useSaveColumnAccess(projectId, datasetId);
  const { nameOf } = useMembers(projectId);
  const [editing, setEditing] = useState<{ column: string | null; visibleTo: RuleMember[] } | null>(null);
  const [removing, setRemoving] = useState<{ column: string | null } | null>(null); // null column: every rule

  const head = (
    <div className={s.head}>
      <h3 id={titleId} className={s.title}>Who sees each column</h3>
      <p className={s.lead}>Hide a column&apos;s values from the viewers you don&apos;t name. The columns computed from it are hidden with it.</p>
    </div>
  );
  const frame = (body: ReactNode) => <section className={s.section} aria-labelledby={titleId}>{head}{body}</section>;
  if (q.isPending) return frame(<SkeletonRows rows={3} label="Loading who sees each column" />);
  if (q.isError) return frame(<ErrorState compact heading={4} title="Who sees each column could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />);
  const reply = q.data;
  if (!reply.ok) return frame(<EmptyState compact heading={4} icon="lock" title="Column access is not available on this server">{reply.error}</EmptyState>);

  const rules = reply.rules;
  const mine = own(rules);
  const ruled = new Set(rules.map((x) => x.column));
  const free = header.columns.map((c) => c.name).filter((c) => !ruled.has(c));
  const gone = mine.map((x) => x.column).filter((c) => !header.columns.some((h) => h.name === c));
  const send = (next: Own[], done: (error?: string) => void, said: string) =>
    save.mutate(next.length ? next : null, {
      onSuccess: (res) => {
        if (!res.ok) return done(res.error);
        toast(said, { kind: 'success' });
        done();
      },
      onError: (e) => done(e.message),
    });
  const quiet = (error?: string) => error && toast(error, { kind: 'error' });
  const who = (x: ColumnRule) => (x.visibleTo.length ? `Only: ${x.visibleTo.map(nameOf).join(', ')}` : 'Hidden from every viewer');
  const hideButton = <Button icon="eye-off" disabled={!free.length} onClick={() => setEditing({ column: null, visibleTo: [] })}>Hide a column…</Button>;

  const warn = reply.state === 'pipeline' ? (
    <div className={r.warn} role="status">
      <Icon name="alert" size={16} />
      <span className={s.grow}>A Prepare step that reads a hidden column changed. Viewers outside these lists can&apos;t open this dataset until you save the rules again.</span>
      <Button size="sm" loading={save.isPending} onClick={() => send(mine, quiet, 'Column rules saved again.')}>Save again</Button>
    </div>
  ) : reply.state === 'gone' ? (
    <div className={r.warn} role="status">
      <Icon name="alert" size={16} />
      <span className={s.grow}>
        {gone.length ? either(gone, 'is no longer a column of this dataset.', 'are no longer columns of this dataset.') : 'A hidden column is no longer in this dataset.'} A source
        rename may have moved its data. Viewers outside these lists can&apos;t open this dataset until you stop hiding it, or hide the column under its new name.
      </span>
    </div>
  ) : reply.state === 'closed' ? (
    <div className={r.warn} role="status">
      <Icon name="alert" size={16} />
      <span className={s.grow}>The saved column rules could not be read, so viewers can&apos;t open this dataset. Hide the columns again, or stop hiding them all.</span>
      <Button size="sm" variant="danger" onClick={() => setRemoving({ column: null })}>Stop hiding all</Button>
    </div>
  ) : null;

  const suggest = reply.suggest.filter((c) => !ruled.has(c));
  const suggestions = suggest.length > 0 && (
    <ul className={s.suggest} aria-label="Suggested">
      {suggest.map((c) => (
        <li key={c} className={s.suggestion}>
          <Icon name="sparkles" size={16} />
          <span className={s.grow}>{c} is marked sensitive. Hide it from viewers?</span>
          <Button size="sm" icon="eye-off" aria-label={`Hide ${c}`} onClick={() => send([...mine, { column: c, visibleTo: [] }], quiet, `${c} is hidden from every viewer. Edit it to choose who sees it.`)}>Hide it</Button>
        </li>
      ))}
    </ul>
  );

  const list = rules.length > 0 && (
    <ul className={s.list} aria-label="Hidden columns">
      {rules.map((x) => (
        <li key={x.column} className={s.item}>
          <Icon name="lock" size={16} />
          <div className={s.text}>
            <span className={s.name}>{x.column}</span>
            <span className={s.dot} aria-hidden="true">·</span>
            <span className={s.who}>{who(x)}</span>
            {x.from !== undefined && <span className={s.carrier}>(hidden too: computed from {x.from})</span>}
          </div>
          {x.from === undefined && (
            <div className={s.acts}>
              <IconButton icon="pencil" size="sm" label={`Edit who sees ${x.column}`} onClick={() => setEditing({ column: x.column, visibleTo: x.visibleTo })} />
              <IconButton icon="trash" size="sm" label={`Stop hiding ${x.column}`} onClick={() => setRemoving({ column: x.column })} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  const body = (
    <div className={r.layout}>
      <div className={s.main}>
        {warn}
        {suggestions}
        {rules.length ? (
          <>
            {list}
            <div className={r.actions}>{hideButton}</div>
          </>
        ) : reply.state !== 'closed' && (
          <EmptyState heading={4} icon="eye" title="No hidden columns" actions={hideButton}>
            Every column is visible to everyone who can open this dataset.
          </EmptyState>
        )}
      </div>
      <aside className={r.summary} aria-label="What hiding a column does">
        <h4 className={r.sumTitle}>What hiding does</h4>
        <ul className={r.sumList}>
          <li><Icon name="lock" size={16} />Viewers it doesn&apos;t name get no values from it, and no figure computed from it. Its name still shows.</li>
          <li><Icon name="user" size={16} />Someone added to the project later doesn&apos;t see it until you name them.</li>
          <li><Icon name="shield" size={16} />Editors and admins see every column.</li>
          <li><Icon name="link" size={16} />Published links, embeds, subscriptions and alerts that read a hidden column are off. The rest keep working.</li>
        </ul>
        {reply.builtFrom.length > 0 && (
          <>
            <h4 className={r.sumTitle}>Also closed to them</h4>
            <p className={r.sumNote}>Datasets built from this one, for the viewers it hides a column from.</p>
            <ul className={r.built}>
              {reply.builtFrom.map((d) => (
                <li key={d.id}><Link to={`/data/${projectId}/${d.id}?tab=access`}>{d.name}</Link></li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );

  const removeAll = removing?.column === null;
  return frame(
    <>
      {body}
      {editing && (
        <RuleDialog
          projectId={projectId}
          column={editing.column}
          free={free}
          initial={editing.visibleTo}
          onClose={() => setEditing(null)}
          onSave={(column, visibleTo, done) => {
            const next = editing.column ? mine.map((x) => (x.column === column ? { column, visibleTo } : x)) : [...mine, { column, visibleTo }];
            send(next, done, `Who sees ${column} is saved.`);
          }}
        />
      )}
      {removing && (
        <Dialog
          open
          size="sm"
          onOpenChange={(o) => !o && setRemoving(null)}
          title={removeAll ? 'Stop hiding every column?' : `Stop hiding ${removing.column}?`}
          description={removeAll
            ? 'Every viewer who can open this dataset will see every column again.'
            : `Every viewer who can open this dataset will see ${removing.column} again, and the columns computed from it.`}
          footer={
            <>
              <DialogClose asChild><Button>Cancel</Button></DialogClose>
              <Button
                variant="danger"
                loading={save.isPending}
                onClick={() => send(removeAll ? [] : mine.filter((x) => x.column !== removing.column), (e) => { quiet(e); setRemoving(null); }, removeAll ? 'Every column is visible again.' : `${removing.column ?? ''} is visible again.`)}
              >
                Stop hiding
              </Button>
            </>
          }
        />
      )}
    </>,
  );
}
