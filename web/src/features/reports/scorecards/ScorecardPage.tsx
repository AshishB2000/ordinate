// /scorecards/:projectId/:scorecardId — one period at a time, every metric a
// row: value, target, attainment, a status dot, the change on the previous
// period, a twelve-period trend, its owner and its latest alert or comment
// count, grouped with a roll-up (scorecardPage.ts). NOTHING HERE COMPUTES A
// FIGURE: `scorecard:compute` returns every value, status, tally and display
// string; stepping the period asks again. A row opens its detail.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { ErrorState, PageSkeleton } from '../../../app/blocks';
import { ago } from '../../../app/when';
import { Button, IconButton, buttonClass } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Menu } from '../../../ui/Menu';
import { Select } from '../../../ui/Select';
import { SkeletonTable } from '../../../ui/Skeleton';
import { EmptyState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { Sparkline } from '../../analyses/metrics/Sparkline';
import { useAdoptProject } from '../../projects/current';
import { failure, STATUS_WORD, type ScorePeriod, type Scorecard, type ScoreResult, type ScoreRow } from '../api';
import { Detail } from './Detail';
import { Dot } from './Dot';
import { RowsEditor } from './RowsEditor';
import s from './Scorecard.module.css';

function Row({ r, selected, onOpen }: { r: ScoreRow; selected: boolean; onOpen: () => void }) {
  // The meter is geometry over the server's attainment (150% fills it); the figure printed is the server's.
  const fill = r.attainment === null ? 0 : Math.max(2, Math.min(100, (r.attainment / 150) * 100));
  return (
    <tr
      className={[s.row, selected && s.selected, r.missing && s.rowMissing].filter(Boolean).join(' ')}
      tabIndex={r.missing ? -1 : 0}
      data-metric-id={r.metricId}
      data-status={r.status}
      onClick={() => !r.missing && onOpen()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !r.missing) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <td className={s.cStatus}><Dot status={r.status} /></td>
      <th scope="row" className={s.cName}>
        <span className={s.metricName}>{r.name}</span>
        {r.undated && <span className={s.note}>All time — no date column</span>}
      </th>
      <td className={s.cNum}>{r.display || '—'}</td>
      <td className={s.cNum} title={r.targetName ? `Target from the metric “${r.targetName}”` : undefined}>{r.targetDisplay || '—'}</td>
      <td className={s.cAtt}>
        {r.attainmentDisplay ? (
          <span className={s.att}>
            <span className={`${s.meter} ${s[`meter_${r.status}`]}`}>
              <span className={s.meterFill} style={{ width: `${fill}%` }} />
              <span className={s.meterTarget} />
            </span>
            <span className={s.attPct}>{r.attainmentDisplay}</span>
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className={`${s.cChange} ${s[`tone_${r.tone}`]}`}>
        {r.deltaDisplay ? (
          <span className={s.change}>
            <Icon name={r.delta !== null && r.delta > 0 ? 'arrow-up' : r.delta !== null && r.delta < 0 ? 'arrow-down' : 'minus'} size={12} />
            {r.deltaDisplay}
            {r.pctDisplay && ` (${r.pctDisplay})`}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className={`${s.cSpark} ${s[`spark_${r.status}`]}`}>{r.spark.length > 0 && <Sparkline values={r.spark} label={`${r.name} over the last ${r.spark.length} periods`} />}</td>
      <td className={s.cOwner}>{r.owner || ''}</td>
      <td className={s.cActivity}>
        {r.alert && (
          <span className={s.activity} title={r.alert.message}>
            <Icon name="bell" size={12} /> {ago(r.alert.at)}
          </span>
        )}
        {!!r.comments && (
          <span className={s.activity} title={`${r.comments} open comment${r.comments === 1 ? '' : 's'} where this metric appears`}>
            <Icon name="message-square" size={12} /> {r.comments}
          </span>
        )}
      </td>
    </tr>
  );
}

function Table({ res, selected, onOpen, onAdd }: { res: ScoreResult; selected: string; onOpen: (id: string) => void; onAdd: () => void }) {
  if (!res.rows.length) {
    return (
      <EmptyState icon="target" title="No metrics on this scorecard yet" actions={<Button variant="primary" onClick={onAdd}>Add metrics</Button>}>
        Add the metrics you want to track, then give each a target.
      </EmptyState>
    );
  }
  const grouped = res.rows.some((r) => r.group);
  const order: string[] = [];
  for (const r of res.rows) if (!order.includes(r.group || '')) order.push(r.group || '');
  // Ungrouped rows last, under "Other".
  if (grouped && order.includes('')) order.push(order.splice(order.indexOf(''), 1)[0]);
  return (
    <table className={s.table}>
      <thead>
        <tr>
          <th scope="col"><span className={s.srOnly}>Status</span></th>
          <th scope="col">Metric</th>
          <th scope="col" className={s.cNum}>{res.window.label || 'Current'}</th>
          <th scope="col" className={s.cNum}>Target</th>
          <th scope="col">Attainment</th>
          <th scope="col">vs previous</th>
          <th scope="col">Last 12</th>
          <th scope="col">Owner</th>
          <th scope="col"><span className={s.srOnly}>Activity</span></th>
        </tr>
      </thead>
      {order.map((g) => {
        const roll = res.groups.find((x) => x.group === g);
        return (
          <tbody key={g || '—'}>
            {grouped && (
              <tr className={s.groupRow}>
                <th scope="rowgroup" colSpan={9}>
                  <span className={s.groupName}>{g || 'Other'}</span>
                  {roll && (
                    <span className={s.groupRoll}>
                      <span className={s.groupMeter}><span style={{ width: `${roll.share}%` }} /></span>
                      {roll.scored ? `${roll.onTrack} of ${roll.scored} on track` : `${roll.total} without targets`}
                    </span>
                  )}
                </th>
              </tr>
            )}
            {res.rows.filter((r) => (r.group || '') === g).map((r) => (
              <Row key={r.metricId} r={r} selected={selected === r.metricId} onOpen={() => onOpen(r.metricId)} />
            ))}
          </tbody>
        );
      })}
    </table>
  );
}

function Page({ projectId, sc, startEditing }: { projectId: string; sc: Scorecard; startEditing: boolean }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState('');
  const [editing, setEditing] = useState(startEditing);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(sc.name);
  const q = useQuery({
    queryKey: ['scorecard:compute', projectId, sc.id, offset, sc.updatedAt],
    queryFn: async () => {
      const r = (await rpc('scorecard:compute', { projectId, id: sc.id, offset })) as ScoreResult | { ok: false; error: string };
      if (!r.ok) throw new Error(r.error || 'Could not compute the scorecard.');
      return r;
    },
    placeholderData: (prev) => prev,
  });
  const reload = () => void client.invalidateQueries({ queryKey: ['scorecard:get', projectId, sc.id] });
  const update = async (patch: { name?: string; period?: ScorePeriod }) => {
    try {
      await rpc('scorecard:update', { projectId, id: sc.id, patch });
      reload();
      void client.invalidateQueries({ queryKey: ['scorecard:list', projectId] });
    } catch (err) {
      toast(failure(err, 'Could not save the scorecard.'), { kind: 'error' });
    }
  };
  const createReport = async () => {
    try {
      const r = (await rpc('scorecard:createReport', { projectId, id: sc.id })) as { ok: boolean; report?: { id: string }; error?: string };
      if (!r.ok || !r.report) throw new Error(failure(r, 'Could not create the report.'));
      void navigate(`/reports/${projectId}/${r.report.id}`);
    } catch (err) {
      toast(failure(err, 'Could not create the report.'), { kind: 'error' });
    }
  };
  const duplicate = async () => {
    const r = (await rpc('scorecard:duplicate', { projectId, id: sc.id }).catch(() => null)) as { ok?: boolean; scorecard?: { id: string } } | null;
    if (r?.ok && r.scorecard) void navigate(`/scorecards/${projectId}/${r.scorecard.id}`);
    else toast('Could not duplicate the scorecard.', { kind: 'error' });
  };
  const remove = async () => {
    await rpc('scorecard:delete', { projectId, id: sc.id }).catch(() => null);
    void client.invalidateQueries({ queryKey: ['scorecard:list', projectId] });
    void navigate(`/reports?project=${projectId}&tab=scorecards`);
  };
  const res = q.data;
  const counts = res?.counts;

  return (
    <div className={detail ? `${s.page} ${s.hasDetail}` : s.page}>
      <header className={s.head}>
        <Link className={buttonClass('ghost', 'sm')} to={`/reports?project=${projectId}&tab=scorecards`}>
          <Icon name="arrow-left" />
          <span>Scorecards</span>
        </Link>
        <h1 className={s.nameH}>
          <input
          className={s.nameInput}
          aria-label="Scorecard name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== sc.name && void update({ name: name.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        </h1>
        <div className={s.headActions}>
          <Button icon="pencil" onClick={() => setEditing(true)}>
            Metrics & targets
          </Button>
          <Menu
            label="Scorecard options"
            align="end"
            trigger={<IconButton icon="more-horizontal" label="Scorecard options" />}
            items={[
              { label: 'Create report…', icon: 'file-text', onSelect: () => void createReport() },
              { label: 'Duplicate', icon: 'copy', onSelect: () => void duplicate() },
              { kind: 'separator' },
              { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setConfirmDelete(true) },
            ]}
          />
        </div>
      </header>
      <div className={s.toolbar}>
        <div className={s.periodPick}>
          <Select
            aria-label="Period"
            size="sm"
            value={sc.period}
            onValueChange={(p) => {
              setOffset(0);
              void update({ period: p as ScorePeriod });
            }}
            options={[
              { value: 'week', label: 'Weekly' },
              { value: 'month', label: 'Monthly' },
              { value: 'quarter', label: 'Quarterly' },
              { value: 'year', label: 'Yearly' },
            ]}
          />
          <IconButton icon="chevron-left" label="Previous period" onClick={() => setOffset((o) => o + 1)} />
          <span className={s.periodLabel} aria-live="polite">
            <strong>{res?.window.label ?? ''}</strong>
            <span>{res ? `${res.window.from} – ${res.window.to}` : ''}</span>
          </span>
          <IconButton icon="chevron-right" label="Next period" disabled={offset <= 0} onClick={() => setOffset((o) => Math.max(0, o - 1))} />
        </div>
        {counts && (
          <div className={s.summary} aria-label="Status summary">
            {(['good', 'warn', 'off', 'none'] as const).map((st) =>
              st === 'none' && !counts.none ? null : (
                <span key={st} className={s.summaryItem}>
                  <Dot status={st} />
                  <strong>{counts[st]}</strong> {STATUS_WORD[st].toLowerCase()}
                </span>
              ),
            )}
          </div>
        )}
      </div>
      <div className={s.body}>
        <section className={q.isFetching && res ? `${s.main} ${s.loading}` : s.main} aria-busy={q.isFetching}>
          {q.isPending ? (
            <SkeletonTable rows={6} cols={8} label="Computing the scorecard" />
          ) : q.isError ? (
            <ErrorState title="Could not compute the scorecard" message={q.error.message} onRetry={() => void q.refetch()} />
          ) : (
            <Table res={q.data} selected={detail} onOpen={setDetail} onAdd={() => setEditing(true)} />
          )}
        </section>
        {detail && <Detail projectId={projectId} scorecardId={sc.id} metricId={detail} offset={offset} onClose={() => setDetail('')} />}
      </div>
      {editing && (
        <RowsEditor
          projectId={projectId}
          sc={sc}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        size="sm"
        title="Delete this scorecard?"
        description={`“${sc.name}” will be deleted. The metrics it shows are not.`}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="danger" onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

export default function ScorecardPage() {
  const { projectId = '', scorecardId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  // ?edit=1 (a new scorecard) opens the targets editor ONCE; a reload must not reopen it.
  const [startEditing] = useState(() => params.get('edit') === '1');
  useEffect(() => {
    if (params.has('edit')) setParams((p) => (p.delete('edit'), p), { replace: true });
  }, [params, setParams]);
  useAdoptProject(projectId);
  const q = useQuery({
    queryKey: ['scorecard:get', projectId, scorecardId],
    queryFn: async () => (await rpc('scorecard:get', { projectId, id: scorecardId })) as Scorecard | null,
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError || !q.data) {
    return (
      <div className={s.page}>
        <ErrorState title="That scorecard could not be opened" message={q.isError ? q.error.message : 'It may have been deleted.'} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  return <Page key={scorecardId} projectId={projectId} sc={q.data} startEditing={startEditing} />;
}
