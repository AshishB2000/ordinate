// One value picker for a dropdown control and a multi-select (docs/dashboard-
// filters/00-design.md): a chip that opens a popover with a search box and the
// column's values as the server lists them — first-seen order, searched in SQL,
// at most 200 with the true total ("Showing the first 200 of N — search to
// narrow"). A dropdown has an "All" row and closes on a pick; a multi has
// checkboxes. A current value the list does not show is pinned at the top.
//
// A LIVE column's values are a schema sync's sample: the panel says so, and
// typed text that matches no listed value can be used as it is ("Use “text”").
// An extract never offers that — its search is exhaustive. A Live column may
// also have no list at all (never synced, not sampled, not a column a list is
// kept for): the server says which, typed, and the chip becomes <NoList> — the
// reason, "Sync schema" for an editor where a sync can list them, and a box to
// type a value into. Never an empty menu (D6).

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatNumber } from '../../../../../src/app/format.ts';
import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { Popover } from '../../../ui/Popover';
import { Icon } from '../../../ui/icons/Icon';
import { useSyncSchema } from '../../data/liveApi';
import { distinctValues, type UnlistedReason } from '../../live/distinct';
import { LiveRefusalError } from '../../live/refusal';
import { useCanEdit } from '../../projects/api';
import { useDebounced } from '../../subscriptions/api';
import type { Card, ControlValue } from '../api';
import s from './FilterBar.module.css';

type Control = NonNullable<Card['control']>;

/** The server's longest search (the `dataset:distinct` contract). */
const MAX_SEARCH = 200;

/**
 * A column's distinct values; the query key `freshness.ts` invalidates when the dataset refreshes. While a search
 * loads, the last list of THIS column stays up (another column's — the control dialog switching — never does).
 */
export function useDistinct(projectId: string, datasetId: string, column: string, search = '') {
  return useQuery({
    queryKey: ['dataset:distinct', projectId, datasetId, column, search],
    enabled: !!datasetId && !!column,
    queryFn: () => distinctValues({ projectId, datasetId, column, limit: 200, ...(search ? { search } : {}) }),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === datasetId && prevQuery.queryKey[3] === column ? prev : undefined),
  });
}

const str = (v: unknown) => (v == null ? '' : String(v));

/** The chip's words per case; the panel carries the server's sentence. */
const NO_LIST: Record<UnlistedReason, string> = { notSynced: 'Not synced yet', notSampled: 'Values not sampled', notListed: 'Values not listed' };

/** The refusal, when this error is a Live column saying it has no list of values to give. */
export function noListOf(err: unknown): (LiveRefusalError & { reason: UnlistedReason }) | null {
  return err instanceof LiveRefusalError && !!err.reason && err.reason in NO_LIST ? (err as LiveRefusalError & { reason: UnlistedReason }) : null;
}

/** The control's picks as a list ('' is the blank value, a real pick). */
function picksOf(control: Control, value: ControlValue | undefined): string[] {
  if (!value) return [];
  if (control.kind === 'multi') return 'values' in value ? value.values : [];
  return 'value' in value ? [value.value] : [];
}

/** A typed value into the control: a dropdown's value, or one more of a multi's. */
function withTyped(control: Control, picked: string[], text: string): ControlValue {
  return control.kind === 'multi' ? { values: picked.includes(text) ? picked : [...picked, text] } : { value: text };
}

/**
 * A control over a Live column with no list of values. The box a picker has
 * (no jump in the bar), saying which case it is; its panel — opened by a press,
 * so it reads on touch — has the server's sentence, "Sync schema" for an editor
 * where a sync can list them (it refetches the values when it lands), and a
 * box to type a value into: the warehouse filters on it all the same.
 */
export function NoList({
  projectId,
  control,
  refusal,
  current,
  picked = [],
  onChange,
}: {
  projectId: string;
  control: Control;
  refusal: LiveRefusalError & { reason: UnlistedReason };
  current: string;
  picked?: string[];
  onChange?: (v: ControlValue | undefined) => void;
}) {
  const canEdit = useCanEdit(projectId);
  const sync = useSyncSchema(projectId, control.datasetId);
  const [said, setSaid] = useState('');
  const [typed, setTyped] = useState('');
  const label = control.label || control.column;
  const words = NO_LIST[refusal.reason];
  const run = () =>
    sync.mutate(undefined, {
      // A sync that lists the values swaps this widget for the picker; one that could not says why, in the server's words.
      onSuccess: (r) => setSaid(!r.ok ? r.error || 'The schema could not be synced.' : r.status === 'already_running' ? r.message : r.sample.ok ? '' : r.sample.error),
      onError: (err) => setSaid(`The schema could not be synced: ${err.message}`),
    });
  const use = () => {
    if (typed && onChange) onChange(withTyped(control, picked, typed));
    setTyped('');
  };
  return (
    <Popover
      trigger={
        <button type="button" className={`${s.multiBtn} ${s.noList}`} aria-label={`${label}: ${current ? `${current}, ` : ''}${words.toLowerCase()}`} data-no-list={refusal.reason}>
          <Icon name="zap" size={12} />
          <span className={s.chipText}>{current || words}</span>
        </button>
      }
      title={label}
    >
      <div className={s.multi}>
        <p className={s.why}>{refusal.message}</p>
        {refusal.reason === 'notListed' && canEdit && <p className={s.more}>Edit this control to use another kind, or a column with fewer values.</p>}
        {refusal.reason !== 'notListed' && canEdit && (
          <Button size="sm" icon="refresh" loading={sync.isPending} onClick={run}>
            Sync schema
          </Button>
        )}
        {said && (
          <p className={s.more} role="status">
            {said}
          </p>
        )}
        {onChange && (
          <form
            className={s.typed}
            onSubmit={(e) => {
              e.preventDefault();
              use();
            }}
          >
            <input className={s.search} aria-label={`Type a ${label} value`} placeholder="Type a value" maxLength={MAX_SEARCH} value={typed} onChange={(e) => setTyped(e.target.value)} />
            <Button size="sm" type="submit" disabled={!typed}>
              Use
            </Button>
          </form>
        )}
      </div>
    </Popover>
  );
}

/** A dropdown or multi control's chip and its popover of values. */
export function ValuePicker({ projectId, control, value, onChange }: { projectId: string; control: Control; value: ControlValue | undefined; onChange: (v: ControlValue | undefined) => void }) {
  const multi = control.kind === 'multi';
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed, 250);
  const q = useDistinct(projectId, control.datasetId, control.column, search);
  const picked = picksOf(control, value);
  const label = control.label || control.column;
  const summary = picked.length === 0 ? 'All' : picked.length === 1 ? picked[0] || '(blank)' : `${picked.length} selected`;
  const noList = noListOf(q.error);
  if (noList) return <NoList projectId={projectId} control={control} refusal={noList} current={picked.length ? summary : ''} picked={picked} onChange={onChange} />;

  const values = (q.data?.values ?? []).map(str);
  const outside = picked.filter((p) => !values.includes(p));
  // Live: the list is a sample, so a value it lacks may still be in the warehouse.
  const offerUse = !!q.data?.approximate && typed !== '' && !values.includes(typed);
  const set = (next: string[]) => onChange(next.length ? { values: next } : undefined);
  const choose = (v: string | undefined) => {
    onChange(v === undefined ? undefined : { value: v });
    setOpen(false);
  };
  const row = (v: string) =>
    multi ? (
      <Checkbox key={v} label={v || '(blank)'} checked={picked.includes(v)} onCheckedChange={(c) => set(c ? [...picked, v] : picked.filter((x) => x !== v))} />
    ) : (
      <button key={v} type="button" className={s.pick} aria-pressed={picked[0] === v} onClick={() => choose(v)}>
        {v || '(blank)'}
      </button>
    );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className={s.multiBtn}
          aria-label={`${label}: ${summary}`}
          aria-busy={q.isPending || undefined}
          aria-invalid={q.isError || undefined}
          title={q.isError ? `The values could not be loaded: ${q.error.message}` : undefined}
        >
          <span className={s.chipText}>{summary}</span>
          <Icon name="chevron-down" size={12} />
        </button>
      }
      title={label}
    >
      <div className={s.multi}>
        <input
          className={s.search}
          type="search"
          placeholder="Search values"
          aria-label="Search values"
          maxLength={MAX_SEARCH}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        {q.data?.approximate && <p className={s.more}>Values from a sample of {formatNumber(q.data.sampleRows ?? 0)} rows.</p>}
        <div className={s.multiList} role="group" aria-label={`${label} values`} aria-busy={q.isFetching || undefined}>
          {!multi && (
            <button type="button" className={s.pick} aria-pressed={picked.length === 0} onClick={() => choose(undefined)}>
              All
            </button>
          )}
          {outside.map(row)}
          {q.isPending && <p className={s.more}>Loading values…</p>}
          {q.isError && (
            <p className={s.more} role="alert">
              The values could not be loaded.{' '}
              <button type="button" className={s.retry} onClick={() => void q.refetch()}>
                Try again
              </button>
            </p>
          )}
          {values.map(row)}
          {offerUse && (
            <button
              type="button"
              className={`${s.pick} ${s.use}`}
              onClick={() => {
                if (multi) onChange(withTyped(control, picked, typed));
                else choose(typed);
              }}
            >
              Use “{typed}”
            </button>
          )}
          {q.isSuccess && values.length === 0 && !offerUse && <p className={s.more}>{search ? `No value matches “${search}”.` : 'This column has no values.'}</p>}
        </div>
        {q.data && q.data.total > q.data.values.length && (
          <p className={s.more}>
            Showing the first {formatNumber(q.data.values.length)} of {formatNumber(q.data.total)} — search to narrow.
          </p>
        )}
        {multi && picked.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => set([])}>
            Clear
          </Button>
        )}
      </div>
    </Popover>
  );
}
