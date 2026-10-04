// /analytics/:projectId/events — the project's launches, campaigns, incidents
// and holidays (eventsPage.ts), each a date or a date range. Every chart with
// a date axis marks them, and Insights / Key drivers name the one a change
// landed in. The list (kind filter, newest first) beside the holiday
// calendars and the CSV import card. Nothing here matches a date: the server
// sends each event's "when" line and day count with the list.

import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { formatNumber } from '../../../../../src/app/format.ts';
import { useDatasets } from '../../../api/datasets';
import { Button, buttonClass, IconButton } from '../../../ui/Button';
import { Switch } from '../../../ui/Choice';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import { useAdoptProject } from '../../projects/current';
import { deleteEvent, importCsv, kindName, KINDS, MAX_CSV, setCalendars, useEvents, useEventsRefresh, type ProjectEvent } from './api';
import { EventEditor } from './EventEditor';
import { KindMark } from './KindMark';
import a from '../Analytics.module.css';
import s from './Events.module.css';

function scopeText(e: ProjectEvent, name: (id: string) => string): string {
  const parts: string[] = [];
  if (e.scope?.datasetIds?.length) parts.push(e.scope.datasetIds.map(name).join(', '));
  for (const f of e.scope?.filters ?? []) parts.push(`${f.column} = ${(f.values || []).join(' or ')}`);
  return parts.length ? parts.join(' · ') : 'All charts';
}

function Calendars({ projectId, on, available, onDone }: { projectId: string; on: string[]; available: Array<{ code: string; name: string; note: string; perYear: number }>; onDone: () => void }) {
  // The switch moves at once and holds while the server stores it; a refusal puts it back.
  const [pending, setPending] = useState<string[] | null>(null);
  const shown = pending ?? on;
  const toggle = async (code: string, want: boolean, name: string) => {
    const next = shown.filter((c) => c !== code).concat(want ? [code] : []);
    setPending(next);
    try {
      await setCalendars(projectId, next);
      toast(want ? `${name} holidays now mark every date axis.` : `${name} holidays switched off.`, { kind: 'success' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the calendars.', { kind: 'error' });
      setPending(null);
    }
    onDone();
  };
  // The list came back with the stored calendars: it speaks for itself again.
  if (pending && pending.length === on.length && pending.every((c) => on.includes(c))) setPending(null);
  return (
    <div className={s.cals}>
      {available.map((c) => (
        <Switch
          key={c.code}
          label={c.name}
          hint={`${c.code} · about ${formatNumber(c.perYear)} a year`}
          title={c.note || undefined}
          disabled={pending !== null}
          checked={shown.includes(c.code)}
          onCheckedChange={(want) => void toggle(c.code, want, c.name)}
        />
      ))}
    </div>
  );
}

export default function EventsPage() {
  const { projectId = '' } = useParams();
  useAdoptProject(projectId);
  const q = useEvents(projectId);
  const datasets = useDatasets(projectId);
  const refresh = useEventsRefresh(projectId);
  const [kind, setKind] = useState('');
  const [editing, setEditing] = useState<ProjectEvent | null | 'new'>(null);
  const [deleting, setDeleting] = useState<ProjectEvent | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const remove = async (e: ProjectEvent) => {
    setDeleting(null);
    try {
      await deleteEvent(projectId, e.id);
      toast(`Deleted "${e.title}".`, { kind: 'success' });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That event no longer exists.', { kind: 'error' });
    }
    refresh();
  };
  const dsName = (id: string) => datasets.data?.find((d) => d.id === id)?.name ?? 'a deleted dataset';
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_CSV) {
      toast('That file is too large for an events list.', { kind: 'error' });
      return;
    }
    try {
      const r = await importCsv(projectId, await f.text());
      const skipped = r.skipped ? ` · ${formatNumber(r.skipped)} ${r.skipped === 1 ? 'row' : 'rows'} skipped (no readable date or title)` : '';
      toast(`Imported ${formatNumber(r.added)} ${r.added === 1 ? 'event' : 'events'} from ${f.name}${skipped}.`, { kind: 'success' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not import that file.', { kind: 'error' });
    }
    refresh();
  };

  const all = q.data?.events ?? [];
  const counts = new Map<string, number>();
  for (const e of all) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const active = kind && counts.get(kind) ? kind : '';
  const shown = all
    .filter((e) => !active || e.kind === active)
    .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : x.title.localeCompare(y.title)));

  return (
    <div className={a.wb}>
      <header className={a.head}>
        <div className={`${a.ident} ${s.identGrow}`}>
          <h1 className={a.title}>
            <span className={a.mark} aria-hidden="true">
              <Icon name="calendar" />
            </span>
            Events
          </h1>
          <p className={a.sub}>Launches, campaigns, incidents and holidays — marked on every chart with a date axis, and named when a figure changes during one.</p>
        </div>
        <div className={a.actions}>
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            New event
          </Button>
          <Button icon="upload" onClick={() => file.current?.click()}>
            Import CSV
          </Button>
          <input
            ref={file}
            type="file"
            accept=".csv,text/csv"
            hidden
            aria-label="Events CSV file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              void onFile(f);
            }}
          />
          <Link className={buttonClass('secondary')} to={`/analytics?project=${projectId}`}>
            <Icon name="x" />
            Analytics
          </Link>
        </div>
      </header>

      <div className={s.layout}>
        <section className={all.length ? s.main : s.mainBare} aria-label="Events list">
          {q.isPending ? (
            <SkeletonRows rows={5} label="Loading events" />
          ) : q.isError ? (
            <ErrorState title="Could not read events" message={q.error.message} onRetry={() => void q.refetch()} heading={2} />
          ) : all.length === 0 ? (
            <EmptyState
              icon="calendar"
              title="No events yet"
              actions={
                <>
                  <Button variant="primary" onClick={() => setEditing('new')}>
                    New event
                  </Button>
                  <Button variant="ghost" onClick={() => file.current?.click()}>
                    Import CSV
                  </Button>
                </>
              }
            >
              Add a launch, a campaign or an outage and every chart with a date axis marks it — a line for a day, a band for a range. When a figure changes during one, Insights and Key drivers say so.
            </EmptyState>
          ) : (
            <>
              <div className={s.bar}>
                <div className={s.pills} role="group" aria-label="Event kinds">
                  {[['', 'All', all.length] as const, ...KINDS.filter(([k]) => counts.get(k)).map(([k, l]) => [k, l, counts.get(k) ?? 0] as const)].map(([k, label, n]) => (
                    <button key={k || 'all'} type="button" className={k === active ? `${s.pill} ${s.pillOn}` : s.pill} aria-pressed={k === active} onClick={() => setKind(k)}>
                      {label}
                      <span className={s.pillN}>{n}</span>
                    </button>
                  ))}
                </div>
                <span className={s.count}>{`${formatNumber(all.length)} ${all.length === 1 ? 'event' : 'events'}`}</span>
              </div>
              <table className={s.table}>
                <caption className={a.sr}>Events, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Kind</th>
                    <th scope="col">When</th>
                    <th scope="col">Applies to</th>
                    <th scope="col">
                      <span className={a.sr}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((e) => {
                    const scope = scopeText(e, dsName);
                    return (
                      <tr key={e.id} data-event-id={e.id}>
                        <th scope="row">
                          <span className={s.name}>
                            <KindMark kind={e.kind} />
                            <button type="button" className={s.title} title="Edit this event" onClick={() => setEditing(e)}>
                              {e.title}
                            </button>
                          </span>
                        </th>
                        <td>
                          <span className={`${s.kindChip} ${s[`k_${e.kind}`]}`}>{kindName(e.kind)}</span>
                        </td>
                        <td>
                          <span className={s.whenMain}>{e.when}</span>
                          <span className={s.whenSub}>{e.end ? `${formatNumber(e.days)} days · drawn as a band` : 'One day · drawn as a marker'}</span>
                        </td>
                        <td className={s.scope} title={scope}>
                          {scope}
                        </td>
                        <td className={s.rowActions}>
                          <IconButton icon="pencil" size="sm" label={`Edit ${e.title}`} onClick={() => setEditing(e)} />
                          <IconButton icon="trash" size="sm" label={`Delete ${e.title}`} onClick={() => setDeleting(e)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </section>

        <aside className={s.side} aria-label="Calendars and import">
          <section className={s.card}>
            <h2 className={s.cardH}>Holiday calendars</h2>
            <p className={s.cardP}>Public holidays, 2015 to 2035, bundled with the app. Switch one on and its holidays mark every date axis in this project.</p>
            {q.data ? <Calendars projectId={projectId} on={q.data.calendars} available={q.data.available} onDone={refresh} /> : <SkeletonRows rows={3} label="Loading calendars" />}
          </section>
          <section className={s.card}>
            <h2 className={s.cardH}>Importing a CSV</h2>
            <p className={s.cardP}>
              One row per event. <b>date</b> and <b>title</b> are required; <b>end</b> makes it a range and <b>kind</b> is launch, campaign, incident, holiday or other.
            </p>
            <pre className={s.sample}>{'date,end,title,kind\n2024-11-25,2024-12-31,Holiday campaign,campaign\n2024-03-04,,v2 launch,launch'}</pre>
          </section>
        </aside>
      </div>

      {editing && (
        <EventEditor
          projectId={projectId}
          datasets={datasets.data ?? []}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(title, isNew) => {
            toast(isNew ? `Added "${title}" — every date axis it falls on now marks it.` : `Saved "${title}".`, { kind: 'success' });
            refresh();
          }}
        />
      )}
      {deleting && (
        <Dialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`Delete "${deleting.title}"?`}
          description="Charts stop marking it and findings stop naming it."
          footer={
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                onClick={() => void remove(deleting)}
              >
                Delete
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
