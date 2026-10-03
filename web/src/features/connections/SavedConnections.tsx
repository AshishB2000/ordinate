// The project's saved connections as cards (legacy connRun.ts). The whole card
// opens the workbench; Delete sits beside it (not nested in it) and asks first.
// The health dot is the LAST TEST's verdict, never a live probe — a list must
// not open a socket per card to render.

import { useState } from 'react';
import { Link } from 'react-router';
import { formatNumber } from '../../../../src/app/format.ts';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { toast } from '../../ui/Toast';
import { deleteConnection, type Connection, type Connector, type Logo } from './api';
import { ConnLogo } from './ConnLogo';
import s from './Connections.module.css';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const formatWhen = (iso: string | null | undefined): string => (iso ? when.format(new Date(iso)) : '');

/** What identifies a connection among several of one kind: host / database, else a path or URL. */
export function where(c: Connection): string {
  const v = c.values;
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
  if (str('host') && str('database')) return `${str('host')} / ${str('database')}`;
  return str('host') || str('database') || str('path') || str('url');
}

export function statusLabel(c: Pick<Connection, 'lastStatus' | 'lastError'>): string {
  if (c.lastStatus === 'ok') return 'Last test succeeded';
  if (c.lastStatus === 'error') return `Last test failed: ${c.lastError || 'unknown error'}`;
  return 'Not tested yet';
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${formatNumber(n)} ${many}`);

export function SavedConnections({
  projectId,
  list,
  catalog,
  logos,
  onDeleted,
}: {
  projectId: string;
  list: readonly Connection[];
  catalog: readonly Connector[];
  logos: Record<string, Logo>;
  onDeleted: () => void;
}) {
  const [doomed, setDoomed] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const label = (c: Connection) => catalog.find((d) => d.id === c.connectorId)?.label ?? c.connectorId;

  async function remove() {
    if (!doomed) return;
    setBusy(true);
    try {
      await deleteConnection(projectId, doomed.id);
      toast(`Deleted “${doomed.name}”.`, { kind: 'success' });
      setDoomed(null);
      onDeleted();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the connection.', { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.saved} aria-labelledby="conn-saved-h">
      <h2 id="conn-saved-h" className={s.sectionH}>
        Saved connections
      </h2>
      <ul className={s.cards}>
        {list.map((c) => {
          const kind = label(c);
          const at = where(c);
          const n = c.datasetCount ?? 0;
          const used = c.lastRefreshedAt ? `used ${formatWhen(c.lastRefreshedAt)}` : 'never used';
          const meta = [plural(n, 'dataset', 'datasets'), c.queries.length ? plural(c.queries.length, 'saved query', 'saved queries') : '', used]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={c.id} className={s.cardWrap}>
              <Link className={s.card} to={`/connections/${projectId}/${c.id}`} aria-label={`Open ${c.name}`}>
                <ConnLogo logo={logos[c.connectorId]} label={kind} />
                <span className={s.cardBody}>
                  <span className={s.cardTop}>
                    <span className={s.cardName}>{c.name}</span>
                    <span className={`${s.dot} ${s[`dot_${c.lastStatus}`]}`} role="img" aria-label={statusLabel(c)} title={statusLabel(c)} />
                  </span>
                  <span className={s.cardSub} title={at ? `${kind} · ${at}` : kind}>
                    {at ? `${kind} · ${at}` : kind}
                  </span>
                  <span className={s.cardSub}>{meta}</span>
                </span>
              </Link>
              <IconButton className={s.cardDel} icon="trash" size="sm" label={`Delete connection ${c.name}`} onClick={() => setDoomed(c)} />
            </li>
          );
        })}
      </ul>
      <Dialog
        open={doomed !== null}
        onOpenChange={(o) => !o && setDoomed(null)}
        title="Delete this connection?"
        description={doomed ? `“${doomed.name}” and its stored credentials are removed. Datasets already imported from it keep their data but can no longer refresh.` : undefined}
        size="sm"
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button variant="danger" icon="trash" loading={busy} onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      />
    </section>
  );
}
