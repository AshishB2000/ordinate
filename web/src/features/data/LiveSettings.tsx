// A Live dataset's settings on its page (docs/live-data/00-plan.md L2.6, D5):
//
//   Live switch     on a Live dataset: off asks first, then copies the data
//                   (`dataset:setMode` → extract; or "Make a copy" beside it);
//                   on an extract whose connection offers Live: on opens the
//                   confirm that says the stored copy goes (./LiveMode).
//   Cache age       how old a cached answer may be: Always live · 1 min ·
//                   5 min (default) · 1 h · 6 h · 1 day (`dataset:setMode`
//                   live → live). An age set another way (the API) is shown too.
//   Refresh now     the cache's epoch moves (`dataset:refresh`), so every
//                   figure asks the warehouse again — on every pod.
//
// The words are formatting; the age, the outcome and every refusal are the server's.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { MakeCopyButton } from '../live/LiveOff';
import { useCan } from '../projects/api';
import { useWrite } from './api';
import { useResetCache, useSetCacheAge } from './liveApi';
import { cacheText, MODE_REFRESH, SwitchToLiveDialog } from './LiveMode';
import { formatNumber } from './format';
import s from './LiveData.module.css';

/** The picker's ages, seconds → words (plan L2.6). */
export const CACHE_AGES: readonly { sec: number; label: string }[] = [
  { sec: 0, label: 'Always live' },
  { sec: 60, label: '1 min' },
  { sec: 300, label: '5 min (default)' },
  { sec: 3_600, label: '1 h' },
  { sec: 21_600, label: '6 h' },
  { sec: 86_400, label: '1 day' },
];

/** The options, with the current age among them even when it was set to something else ("up to 10 min"). */
export function cacheAgeOptions(current: number | undefined): { value: string; label: string }[] {
  const known = CACHE_AGES.map((a) => ({ sec: a.sec, label: a.label }));
  if (current !== undefined && !known.some((a) => a.sec === current)) {
    known.push({ sec: current, label: cacheText(current).replace(/^cached up to /, '') });
    known.sort((a, b) => a.sec - b.sec);
  }
  return known.map((a) => ({ value: String(a.sec), label: a.label }));
}

/** "Answers cached: 5 min (default)". */
export function CacheAgePicker({ projectId, datasetId, name, maxCacheAgeSec }: { projectId: string; datasetId: string; name: string; maxCacheAgeSec: number | undefined }) {
  const set = useSetCacheAge(projectId, datasetId);
  const can = useCan(projectId);
  const pick = (v: string) =>
    set.mutate(Number(v), {
      onSuccess: (r) => {
        if (!r.ok) toast(r.error || 'The cache age could not be changed.', { kind: 'error' });
        else toast(r.maxCacheAgeSec === 0 ? `Every figure on “${name}” now asks the warehouse.` : `Answers on “${name}” are ${cacheText(r.maxCacheAgeSec)}.`, { kind: 'success' });
      },
      onError: (err) => toast(`The change did not go through: ${err.message}`, { kind: 'error' }),
    });
  return (
    <span className={s.age} title="How old a cached answer may be before a figure asks the warehouse again">
      <span className={s.ageLabel} aria-hidden="true">
        Cache
      </span>
      <Select
        size="sm"
        aria-label={`Cache age of ${name}`}
        className={s.ageSelect}
        value={maxCacheAgeSec === undefined ? null : String(maxCacheAgeSec)}
        placeholder="5 min (default)"
        options={cacheAgeOptions(maxCacheAgeSec)}
        disabled={set.isPending || !can('editor')}
        onValueChange={pick}
      />
    </span>
  );
}

/** "Refresh now": the next figure asks the warehouse, whatever the cache holds. */
export function RefreshNow({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const reset = useResetCache(projectId, datasetId);
  const [said, setSaid] = useState<{ text: string; error?: boolean } | null>(null);
  const can = useCan(projectId);
  const run = () =>
    reset.mutate(undefined, {
      onSuccess: (r) => setSaid(r.ok ? { text: 'Cache reset — the next figure asks the warehouse.' } : { text: r.error || 'The cache could not be reset.', error: true }),
      onError: (err) => setSaid({ text: `The cache could not be reset: ${err.message}`, error: true }),
    });
  return (
    <>
      <Button size="sm" icon="refresh" loading={reset.isPending} disabled={!can('editor')} title="Reset the cache: every chart, KPI tile and answer asks the warehouse again" onClick={run}>
        Refresh now
      </Button>
      {said && (
        <span className={said.error ? s.sayError : s.say} role="status">
          {said.text}
        </span>
      )}
    </>
  );
}

/** Live → a copy kept here: said first, because the dataset stops asking the warehouse. */
function CopyTheDataDialog({ projectId, datasetId, name, onClose }: { projectId: string; datasetId: string; name: string; onClose: () => void }) {
  const [error, setError] = useState('');
  const set = useWrite('dataset:setMode', MODE_REFRESH, {
    quiet: true,
    onDone: (r: { ok?: boolean; error?: string }) => {
      if (r.ok === false) return setError(r.error || 'The data could not be copied.');
      toast(`“${name}” keeps a copy of its rows now.`, { kind: 'success' });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Copy the data instead?"
      description="The warehouse is read once and its rows are stored here, then refreshed on a schedule. Charts answer from the copy, and every tool works on it."
      footer={
        <>
          <DialogClose asChild>
            <Button>Keep it Live</Button>
          </DialogClose>
          <MakeCopyButton projectId={projectId} datasetId={datasetId} variant="secondary" />
          <Button variant="primary" icon="download" loading={set.isPending} onClick={() => (setError(''), set.mutate({ projectId, datasetId, mode: 'extract' }))}>
            Copy the data
          </Button>
        </>
      }
    >
      <p>
        {`Up to ${formatNumber(1_000_000)} rows are copied. To keep “${name}” Live and work on a copy beside it, choose “Make a copy” instead.`}
      </p>
      {error && (
        <p role="alert" className={s.sayError}>
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** The Live switch: on for a Live dataset; offered on an extract only when its connection can go Live. */
export function LiveSwitch({ projectId, datasetId, name, live, canGoLive, rowCount }: {
  projectId: string;
  datasetId: string;
  name: string;
  live: boolean;
  canGoLive: boolean;
  rowCount: number;
}) {
  const [asking, setAsking] = useState(false);
  const can = useCan(projectId);
  if (!live && !canGoLive) return null;
  return (
    <span className={s.switch}>
      <Switch label="Live" checked={live} disabled={!can('editor')} onCheckedChange={() => setAsking(true)} />
      {asking && live && <CopyTheDataDialog projectId={projectId} datasetId={datasetId} name={name} onClose={() => setAsking(false)} />}
      {asking && !live && <SwitchToLiveDialog projectId={projectId} datasetId={datasetId} name={name} rowCount={rowCount} onClose={() => setAsking(false)} />}
    </span>
  );
}
