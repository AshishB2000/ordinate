// Admin → Autopilot: one card per project. Off by default; an admin switches it on and it acts as them, checked at every run.
// What it may do on its own is the two safe things (Trash moves, exact rename repairs), each with Undo; everything else is listed.

import { useNavigate } from 'react-router';
import { Link } from 'react-router';
import { useState } from 'react';
import { Badge } from '../../ui/Badge';
import { Button, buttonClass } from '../../ui/Button';
import { Checkbox, Switch } from '../../ui/Choice';
import { Input } from '../../ui/Field';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { dayInYear } from '../data/format';
import { useOverview, useRunNow, useSave, type OverviewProject, type Patch } from './api';
import s from './Autopilot.module.css';
import a from '../admin/Admin.module.css';

const when = (iso: string): string => dayInYear.format(new Date(`${iso.slice(0, 10)}T12:00:00`));

function Status({ p }: { p: OverviewProject }) {
  const { settings: st, latest, firstCleanup } = p;
  if (!st.enabled) return <span className={s.status}>Off</span>;
  if (st.pausedReason) return <Badge tone="warn">Paused</Badge>;
  if (firstCleanup && firstCleanup > new Date().toISOString().slice(0, 10)) return <span className={s.status}>Waiting for data: the first cleanup can happen on {when(firstCleanup)}</span>;
  return latest ? <span className={s.status}>Last run {when(latest.startedAt)}</span> : <span className={s.status}>On. The first run is at the next hourly check.</span>;
}

function Card({ p }: { p: OverviewProject }) {
  const st = p.settings;
  const navigate = useNavigate();
  const save = useSave(p.id);
  const run = useRunNow(p.id, (runId) => void navigate(`/autopilot/${p.id}/${runId}`));
  const [days, setDays] = useState(String(st.windowDays));
  const [secs, setSecs] = useState(String(st.slowSeconds));
  const daysBad = !Number.isInteger(Number(days)) || Number(days) < 30 || Number(days) > 365 ? 'A whole number of days from 30 to 365.' : undefined;
  const secsBad = !(Number(secs) >= 0.5 && Number(secs) <= 600) ? 'Seconds, from 0.5 to 600.' : undefined;
  const set = (patch: Patch) => save.mutate(patch);
  return (
    <section className={s.card} aria-label={`Autopilot for ${p.name}`}>
      <div className={s.head}>
        <span className={s.name}>{p.name}</span>
        <Status p={p} />
        <span className={s.grow} />
        <Switch label="Autopilot" checked={st.enabled} onCheckedChange={(on) => set({ enabled: on })} disabled={save.isPending} />
      </div>
      {st.pausedReason && (
        <p className={s.pause} role="status">
          {st.runAs} switched it on and is no longer an admin, so it stopped without changing anything. Switch it on again to run it as you.
          {' '}<Button size="sm" onClick={() => set({ enabled: true })}>Run it as me</Button>
        </p>
      )}
      {st.enabled && (
        <>
          <div className={s.fields}>
            <Input label="Unused after (days)" type="number" inputMode="numeric" min={30} max={365} value={days} error={daysBad} hint="A chart not opened for this long may be moved to Trash."
              onChange={(e) => setDays(e.target.value)} onBlur={() => !daysBad && Number(days) !== st.windowDays && set({ windowDays: Number(days) })} />
            <Input label="Slow above (seconds)" type="number" inputMode="decimal" min={0.5} max={600} step={0.5} value={secs} error={secsBad} hint="A chart whose typical time this week is over this is listed."
              onChange={(e) => setSecs(e.target.value)} onBlur={() => !secsBad && Number(secs) !== st.slowSeconds && set({ slowSeconds: Number(secs) })} />
            <fieldset className={s.fieldset}>
              <legend className={s.status}>It may do on its own</legend>
              <Checkbox label="Move unused charts to Trash" checked={st.trashUnused} onCheckedChange={(on) => set({ trashUnused: on })} />
              <Checkbox label="Repair exact column renames" checked={st.repairRenames} onCheckedChange={(on) => set({ repairRenames: on })} />
            </fieldset>
          </div>
          <p className={s.status}>Runs as {st.runAs}. Charts on a dashboard or in a Story, on certified data, or newer than the window are never moved. Everything it does has Undo.</p>
          <div className={s.actions}>
            <Button icon="play" onClick={() => run.mutate()} loading={run.isPending}>Run now</Button>
            {p.latest && <Link className={buttonClass('ghost')} to={`/autopilot/${p.id}/${p.latest.id}`}>Latest report</Link>}
          </div>
        </>
      )}
    </section>
  );
}

export function AutopilotTab() {
  const q = useOverview();
  let body;
  if (q.isPending) body = <SkeletonRows rows={3} label="Loading Autopilot" />;
  else if (q.isError) body = <ErrorState heading={3} title="Autopilot could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (q.data.length === 0) body = <EmptyState heading={3} icon="folder" title="No projects yet">Autopilot is set up per project, once there is one.</EmptyState>;
  else body = <div className={s.cards}>{q.data.map((p) => <Card key={p.id} p={p} />)}</div>;
  return (
    <section className={a.section} aria-label="Autopilot">
      <p className={a.lead}>
        A weekly cleanup for each project. It moves charts nobody has opened for a long time to Trash, repairs charts that a column rename broke, and lists charts that are slow.
        It is off until you switch it on, it acts as the admin who did, and every move can be undone. It only starts calling charts unused once it has watched for a whole window.
      </p>
      {body}
    </section>
  );
}
