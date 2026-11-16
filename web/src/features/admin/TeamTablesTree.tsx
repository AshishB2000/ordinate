// One connection's tables on Admin → Teams → <team> → Tables: its schemas, each with a tick that gives every table in
// it (new ones too), and its tables, each with a tick, the columns this team's viewers never read, and the name viewers
// read it by. The tables come from `connection:listTables` — a warehouse call, so only on "Show tables" — and the
// names from the project's source table docs (records). Every change saves at once (./teamTablesApi).

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { describeTable, qualify, useTables, type Connection, type Table } from '../connections/api';
import { LIST as SOURCE_LIST, type SourceRow } from '../model/sources/api';
import { saveLabel, schemaTicked, setHidden, tableState, tickedCount, toggleSchema, toggleTable, type Tick } from './teamTablesApi';
import s from './TeamTables.module.css';

/** Tables drawn per schema before "Show all": a warehouse can hold thousands. */
const SHOWN = 100;

interface Props {
  projectId: string;
  conn: Connection;
  ticks: readonly Tick[];
  docs: readonly SourceRow[];
  onChange: (next: Tick[]) => void;
}

function HideColumnsDialog({ projectId, conn, table, hidden, onSave, onClose }: { projectId: string; conn: Connection; table: string; hidden: readonly string[]; onSave: (cols: string[]) => void; onClose: () => void }) {
  const cols = useQuery({ queryKey: ['connection:describe', projectId, conn.id, table], queryFn: () => describeTable(projectId, conn.id, table), retry: false });
  const [picked, setPicked] = useState<Set<string>>(new Set(hidden));
  let body;
  if (cols.isPending) body = <SkeletonTable cols={1} rows={5} label="Loading columns" />;
  else if (cols.isError) body = <ErrorState compact heading={3} title="Columns could not be read" message={cols.error.message} onRetry={() => void cols.refetch()} />;
  else if (!cols.data?.columns.length) body = <EmptyState compact heading={3} icon="columns" title="No columns to hide">This connection does not describe its tables.</EmptyState>;
  else {
    body = (
      <div className={s.columnList}>
        {cols.data.columns.map((c) => (
          <Checkbox
            key={c.name}
            label={c.name}
            hint={c.type}
            checked={picked.has(c.name)}
            onCheckedChange={(on) => setPicked((p) => { const n = new Set(p); if (on) n.add(c.name); else n.delete(c.name); return n; })}
          />
        ))}
      </div>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Hide columns of ${table}`}
      description="This team's viewers never see a hidden column: not in an answer, a chart or the Assistant's prompt. A column another team they are in can see stays visible to them."
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" disabled={!cols.isSuccess} onClick={() => { onSave([...picked]); onClose(); }}>
            Save
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}

/** What a ticked table looks like to the team's viewers, in a word. */
function viewerNote(doc: SourceRow | undefined): { tone: 'ok' | 'warn'; text: string } {
  if (!doc?.label) return { tone: 'warn', text: 'Name it for viewers: until then they are not offered it' };
  if (!doc.readAt) return { tone: 'warn', text: 'Read its columns on the Source tables page first' };
  return { tone: 'ok', text: `Viewers see it as “${doc.label}”` };
}

function TableRow({ projectId, conn, schema, table, ticks, doc, onChange }: Omit<Props, 'docs'> & { schema: string; table: Table; doc: SourceRow | undefined }) {
  const qc = useQueryClient();
  const name = qualify(table);
  const st = tableState(ticks, conn.id, schema, table.name);
  const [hiding, setHiding] = useState(false);
  const [saving, setSaving] = useState(false);
  const note = viewerNote(doc);
  async function rename(label: string): Promise<void> {
    if (label === (doc?.label ?? '')) return;
    setSaving(true);
    try {
      await saveLabel(projectId, conn.id, name, doc?.docId, label);
      await qc.invalidateQueries({ queryKey: [SOURCE_LIST, projectId] });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The name could not be saved.', { kind: 'error' });
    } finally {
      setSaving(false);
    }
  }
  return (
    <li className={s.tableRow} data-testid="team-table-row">
      <Checkbox label={table.name} checked={st.given} onCheckedChange={(on) => onChange(toggleTable(ticks, conn.id, schema, table.name, on))} />
      {st.given && (
        <div className={s.tableTools}>
          <Input
            key={`${doc?.docId ?? name}:${doc?.label ?? ''}`}
            aria-label={`Name ${table.name} for viewers`}
            size="sm"
            className={s.labelField}
            placeholder="Name for viewers"
            defaultValue={doc?.label ?? ''}
            maxLength={120}
            disabled={saving}
            onBlur={(e) => void rename(e.target.value.trim())}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <Button size="sm" icon="eye-off" onClick={() => setHiding(true)}>
            {st.hidden.length ? `Hides ${st.hidden.join(', ')}` : 'Hide columns'}
          </Button>
          <span className={note.tone === 'ok' ? s.noteOk : s.noteWarn}>
            <Icon name={note.tone === 'ok' ? 'circle-check' : 'alert'} size={12} />
            {note.text}
          </span>
        </div>
      )}
      {hiding && (
        <HideColumnsDialog projectId={projectId} conn={conn} table={name} hidden={st.hidden} onClose={() => setHiding(false)} onSave={(cols) => onChange(setHidden(ticks, conn.id, schema, table.name, cols))} />
      )}
    </li>
  );
}

function SchemaGroup({ schema, tables, ...p }: Omit<Props, 'docs'> & { schema: string; tables: readonly Table[]; docs: ReadonlyMap<string, SourceRow> }) {
  const [all, setAll] = useState(false);
  const on = schemaTicked(p.ticks, p.conn.id, schema);
  const shown = all ? tables : tables.slice(0, SHOWN);
  return (
    <section className={s.schema} aria-label={schema ? `Schema ${schema}` : 'Tables'}>
      {schema ? (
        <Checkbox
          className={s.schemaTick}
          label={schema}
          hint={on ? 'Whole schema, tables added later included' : `${tables.length} ${tables.length === 1 ? 'table' : 'tables'}`}
          checked={on}
          onCheckedChange={(v) => p.onChange(toggleSchema(p.ticks, p.conn.id, schema, v))}
        />
      ) : null}
      <ul className={s.tables}>
        {shown.map((t) => <TableRow key={qualify(t)} {...p} schema={schema} table={t} doc={p.docs.get(qualify(t))} />)}
      </ul>
      {!all && tables.length > SHOWN && (
        <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
          Show all {tables.length} tables
        </Button>
      )}
    </section>
  );
}

export function ConnectionTables(p: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const tables = useTables(p.projectId, p.conn.id, open);
  const docs = useMemo(() => new Map(p.docs.map((d) => [d.table, d])), [p.docs]);
  const groups = useMemo(() => {
    const by = new Map<string, Table[]>();
    const f = filter.trim().toLowerCase();
    for (const t of tables.data ?? []) if (!f || qualify(t).toLowerCase().includes(f)) by.set(t.schema ?? '', [...(by.get(t.schema ?? '') ?? []), t]);
    return [...by];
  }, [tables.data, filter]);
  const n = tickedCount(p.ticks, p.conn.id);
  let body = null;
  if (open) {
    if (tables.isPending) body = <SkeletonTable cols={2} rows={5} label="Loading tables" />;
    else if (tables.isError) body = <ErrorState compact heading={3} title="Tables could not be listed" message={tables.error.message} onRetry={() => void tables.refetch()} />;
    else if (!tables.data.length) body = <EmptyState compact heading={3} icon="table" title="No tables">This connection lists no tables to give.</EmptyState>;
    else {
      body = (
        <>
          <Input aria-label={`Find a table in ${p.conn.name}`} className={s.find} placeholder="Find a table" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {groups.length ? groups.map(([schema, ts]) => <SchemaGroup key={schema} {...p} schema={schema} tables={ts} docs={docs} />) : <p className={s.muted}>No table matches “{filter}”.</p>}
        </>
      );
    }
  }
  return (
    <section className={s.conn} aria-label={p.conn.name} data-testid="team-tables-connection">
      <header className={s.connHead}>
        <div>
          <h3 className={s.connName}>{p.conn.name}</h3>
          <p className={s.muted}>{n ? `${n} ${n === 1 ? 'tick' : 'ticks'} for this team` : 'Nothing ticked: this team\'s viewers ask about none of its tables'}</p>
        </div>
        <Button size="sm" icon={open ? 'chevron-up' : 'chevron-down'} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide tables' : 'Show tables'}
        </Button>
      </header>
      {body}
    </section>
  );
}
