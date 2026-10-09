// The workbench's RIGHT rail (legacy connDetails.ts): the connection as a
// record, and what has been imported from it.
//
// It never re-saves the connection. "Test" re-reads the table list with the
// STORED credential, and shows what the source warned about beside "OK". A
// secret field shows only whether a value is stored — "Set" / "Not set", or
// "Key saved" for a multi-line one — and "Replace" opens an EMPTY input (the
// masked SecretTextarea for a multi-line secret) whose value the server tests
// before it keeps it; the old one is never shown, and neither is the new.

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { formatNumber } from '../../../../src/app/format.ts';
import { Badge, type BadgeTone } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { refreshDataset, replaceSecret, setSchedule, type CatalogField, type ConnDataset, type Connection, type Connector } from './api';
import { SecretTextarea } from './SecretText';
import { formatWhen } from './SavedConnections';
import s from './Workbench.module.css';

const SCHEDULE = [
  { value: 'off', label: 'Auto-refresh off' },
  { value: 'hourly', label: 'Refresh hourly' },
  { value: 'daily', label: 'Refresh daily' },
  { value: 'weekly', label: 'Refresh weekly' },
];

export type TestState = 'ok' | 'error' | 'untested' | 'testing';
const TONE: Record<TestState, BadgeTone> = { ok: 'ok', error: 'error', untested: 'neutral', testing: 'accent' };
const WORD: Record<TestState, string> = { ok: 'OK', error: 'Failed', untested: 'Untested', testing: 'Testing…' };

function SecretRow({ f, set, projectId, conn, onReplaced }: { f: CatalogField; set: boolean; projectId: string; conn: Connection; onReplaced: () => void }) {
  const multiline = f.type === 'textarea';
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value) return setError(`Type the new ${f.label.toLowerCase()}.`);
    setBusy(true);
    setError('');
    try {
      await replaceSecret(projectId, conn.id, f.key, value);
      setValue('');
      setOpen(false);
      toast(`${f.label} replaced — the connection tested OK with it.`, { kind: 'success' });
      onReplaced();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not replace it.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={s.kvSecret}>
      <dt>{f.label}</dt>
      <dd className={s.secret}>
        <Badge tone={set ? 'ok' : 'neutral'} icon={set ? 'lock' : undefined}>
          {set ? (multiline ? 'Key saved' : 'Set') : 'Not set'}
        </Badge>
        {!open && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Replace ${f.label}`}>
            Replace
          </Button>
        )}
        {open && (
          <form className={s.replace} onSubmit={(e) => void submit(e)}>
            {multiline ? (
              <SecretTextarea
                label={`New ${f.label.toLowerCase()}`}
                placeholder={f.placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                error={error || undefined}
                hint="Tested before it is kept. Write-only: never shown again."
                autoFocus
              />
            ) : (
              <Input
                size="sm"
                type="password"
                label={`New ${f.label.toLowerCase()}`}
                autoComplete="new-password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                error={error || undefined}
                hint="Tested before it is kept. Write-only: never shown again."
                autoFocus
              />
            )}
            <div className={s.replaceActions}>
              <Button size="sm" variant="primary" type="submit" loading={busy}>
                Test &amp; replace
              </Button>
              <Button size="sm" variant="ghost" onClick={() => (setOpen(false), setValue(''), setError(''))}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </dd>
    </div>
  );
}

function DatasetRow({ d, projectId, connId, onChanged }: { d: ConnDataset; projectId: string; connId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const every = d.autoRefresh?.every ?? null;
  const stamp = formatWhen(d.lastRefreshedAt ?? d.updatedAt);
  const when = every ? `Refreshes ${every} · last ${stamp}` : `Data as of ${stamp}`;
  async function refresh() {
    setBusy(true);
    try {
      await refreshDataset(projectId, connId, d.id);
      toast(`Refreshed “${d.name}”.`, { kind: 'success' });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not refresh that dataset.', { kind: 'error' });
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  async function schedule(v: string) {
    try {
      await setSchedule(projectId, d.id, v === 'off' ? null : (v as 'hourly' | 'daily' | 'weekly'));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the schedule.', { kind: 'error' });
    }
    onChanged();
  }
  const failed = d.lastRefreshStatus === 'error';
  return (
    <li className={failed ? `${s.dsRow} ${s.dsError}` : s.dsRow}>
      <div className={s.dsTop}>
        <Link className={s.dsName} to={`/data/${projectId}/${d.id}`} title="Open this dataset">
          {d.name}
        </Link>
        <Button size="sm" icon="refresh" loading={busy} onClick={() => void refresh()} aria-label={`Refresh ${d.name} now`}>
          Refresh now
        </Button>
      </div>
      <p className={s.dsMeta} title={failed ? d.lastRefreshError || 'The last refresh failed' : undefined}>
        {when} · {d.rowCount === 1 ? '1 row' : `${formatNumber(d.rowCount)} rows`}
        {failed && ` · last refresh failed: ${d.lastRefreshError || 'unknown error'}`}
      </p>
      {d.originKind && <Select size="sm" aria-label={`Auto-refresh ${d.name}`} value={every ?? 'off'} onValueChange={(v) => void schedule(v)} options={SCHEDULE} />}
    </li>
  );
}

export function DetailsRail({
  conn,
  def,
  projectId,
  test,
  testError,
  testWarnings = [],
  onTest,
  datasets,
  onChanged,
}: {
  conn: Connection;
  def: Connector | null;
  projectId: string;
  test: TestState;
  testError: string;
  /** What the last passing test warned about (an administrator role). */
  testWarnings?: readonly string[];
  onTest: () => void;
  datasets: readonly ConnDataset[];
  onChanged: () => void;
}) {
  const fields = def?.fields ?? [];
  return (
    <aside className={`${s.pane} ${s.details}`} aria-label="Connection details" id="conn-wb-details">
      <h2 className={s.detailsH}>Connection</h2>
      <dl className={s.kv}>
        {fields.map((f) => {
          if (f.secret) return <SecretRow key={f.key} f={f} set={conn.secretSet?.[f.key] === true} projectId={projectId} conn={conn} onReplaced={onChanged} />;
          const raw = conn.values[f.key];
          if (raw === undefined || raw === null || raw === '') return null;
          const text = typeof raw === 'boolean' ? (raw ? 'Yes' : 'No') : String(raw);
          return (
            <div key={f.key} className={s.kvPair}>
              <dt>{f.label}</dt>
              <dd title={text}>{text}</dd>
            </div>
          );
        })}
      </dl>
      <div className={s.testRow}>
        <Button size="sm" icon="activity" onClick={onTest} disabled={test === 'testing'}>
          Test
        </Button>
        <span title={test === 'error' ? testError : undefined}>
          <Badge tone={TONE[test]}>{WORD[test]}</Badge>
        </span>
      </div>
      {test === 'error' && testError && (
        <p className={s.testError} role="alert">
          {testError}
        </p>
      )}
      {test === 'ok' &&
        testWarnings.map((w) => (
          <p key={w} className={s.testWarn} role="status">
            <Icon name="alert" size={12} />
            <span>{w}</span>
          </p>
        ))}
      <h2 className={s.detailsH}>Datasets from this connection</h2>
      {datasets.length === 0 ? (
        <p className={s.msg}>Nothing imported from this connection yet. Pick a table or run a query, then Save as dataset.</p>
      ) : (
        <ul className={s.dsList}>
          {datasets.map((d) => (
            <DatasetRow key={d.id} d={d} projectId={projectId} connId={conn.id} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </aside>
  );
}
