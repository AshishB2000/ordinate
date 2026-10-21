// /analytics/scenarios/:projectId/:scenarioId — an open SCENARIO
// (scenarioPage.ts): the setup on the left, the results on the right. A change
// recomputes the DRAFT at once (120 ms) and is saved shortly after (600 ms),
// like a story; leaving the page saves what is pending. A viewer's what-ifs
// are computed (`scenario:compute` is a read over the draft) and never saved.
//
// NOTHING HERE COMPUTES A FIGURE: `scenario:compute` returns every value,
// change, label and bar.

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../../app/blocks';
import { Badge } from '../../../ui/Badge';
import { buttonClass, IconButton } from '../../../ui/Button';
import { Menu } from '../../../ui/Menu';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { Icon } from '../../../ui/icons/Icon';
import { useRoles } from '../../projects/api';
import { useAdoptProject } from '../../projects/current';
import { call, useScenarioMetrics, type Scenario, type ScenarioResult, type ScenarioTargets } from '../api';
import { DeleteScenario, duplicateScenario } from './ScenarioParts';
import { ScenarioResults } from './ScenarioResults';
import { LiveRefusal } from '../../live/LiveOff';
import { LIVE_OFF } from '../../live/offFeatures';
import { liveRefusalOf } from '../../live/refusal';
import { ScenarioSetup, type Draft } from './ScenarioSetup';
import f from './Scenarios.module.css';
import s from './ScenarioEditor.module.css';
import { ConflictBanner } from '../../editConflicts/ConflictBanner';
import { useDropOnLeave, useEditGuard, useReload } from '../../editConflicts/useEditGuard';

/** The value `v`, settled for `ms` (the draft a compute or a save is for). */
function useSettled<T>(v: T, ms: number): T {
  const [settled, setSettled] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setSettled(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return settled;
}

function Editor({ projectId, sc, readOnly, onReload }: { projectId: string; sc: Scenario; readOnly: boolean; onReload: () => void }) {
  const [draft, setDraft] = useState<Draft>({ name: sc.name, baseMetricIds: sc.baseMetricIds, drivers: sc.drivers });
  const [focus, setFocus] = useState('');
  const [status, setStatus] = useState('');
  const [doomed, setDoomed] = useState(false);
  const nav = useNavigate();
  const client = useQueryClient();
  const metrics = useScenarioMetrics(projectId);

  // Compute the draft on screen.
  const live = useSettled(draft, 120);
  const result = useQuery({
    queryKey: ['scenario:compute', projectId, sc.id, live.baseMetricIds, live.drivers, focus],
    queryFn: () =>
      call<ScenarioResult>(
        rpc('scenario:compute', { projectId, id: sc.id, draft: { baseMetricIds: live.baseMetricIds, drivers: live.drivers }, ...(focus ? { focusMetricId: focus } : {}) }),
        'Could not compute the scenario.',
      ),
    placeholderData: keepPreviousData,
  });
  const targets = useQuery({
    queryKey: ['scenario:targets', projectId, live.baseMetricIds],
    queryFn: async () => (await rpc('scenario:targets', { projectId, baseMetricIds: live.baseMetricIds })) as ScenarioTargets,
    placeholderData: keepPreviousData,
  });

  // Save the draft shortly after the last change; leaving saves what is pending. One save at a time, each with the
  // tag the last returned (docs/edit-conflicts); once another tab or person saved first, nothing more is sent.
  const guard = useEditGuard({ projectId, type: 'scenario', id: sc.id }, sc.tag);
  const saved = useRef(JSON.stringify(draft));
  const pending = useRef<Draft | null>(null);
  const flush = useRef(async () => {});
  flush.current = async () => {
    const d = pending.current;
    if (!d) return;
    pending.current = null;
    const sent = guard.save((base) => rpc('scenario:update', { projectId, id: sc.id, base, patch: { name: d.name, baseMetricIds: d.baseMetricIds, drivers: d.drivers } }));
    const out = await sent.catch(() => undefined);
    if (out === null) return setStatus('Not saved'); // changed elsewhere: the banner
    const res = await call<{ ok: true; scenario: Scenario; tag?: string }>(Promise.resolve(out), 'Could not save.');
    if (res.ok) {
      saved.current = JSON.stringify(d);
      // The page's record as saved (the dock names it from here); a reopen reads it fresh.
      client.setQueryData(['scenario:get', projectId, sc.id], { ...res.scenario, tag: res.tag });
    }
    setStatus(res.ok ? 'Saved' : 'Could not save');
    void client.invalidateQueries({ queryKey: ['scenario:list', projectId] });
  };
  const conflict = {
    copy: async () => {
      const r = await call<{ ok: true; scenario: Scenario }>(
        rpc('scenario:create', { projectId, input: { name: `${draft.name || sc.name} (copy)`.slice(0, 200), baseMetricIds: draft.baseMetricIds, drivers: draft.drivers } }),
        'The copy could not be saved.',
      );
      if (!r.ok) throw new Error(r.error);
      void client.invalidateQueries({ queryKey: ['scenario:list', projectId] });
      await nav(`/analytics/scenarios/${projectId}/${r.scenario.id}`);
    },
  };
  useEffect(() => {
    if (readOnly || JSON.stringify(draft) === saved.current) return;
    pending.current = draft;
    setStatus('Editing…');
    const t = setTimeout(() => void flush.current(), 600);
    return () => clearTimeout(t);
  }, [draft, readOnly]);
  useEffect(() => () => void flush.current(), []);

  const res = result.data;
  return (
    <div className={f.page}>
      <div className={f.head}>
        <Link className={buttonClass('secondary', 'sm')} to={`/analytics/scenarios/${projectId}`}>
          <Icon name="arrow-left" />
          Back
        </Link>
        {readOnly ? (
          <>
            <h1 className={s.nameText}>{sc.name || 'Scenario'}</h1>
            <Badge icon="eye">View only</Badge>
            <span className={s.status}>What-ifs here are not saved</span>
          </>
        ) : (
          <>
            <h1 className={f.srOnly}>{draft.name || 'Scenario'}</h1>
            <input
              className={s.name}
              type="text"
              aria-label="Scenario name"
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onBlur={() => !draft.name.trim() && setDraft({ ...draft, name: sc.name })}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <span className={s.status} aria-live="polite">
              {status}
            </span>
          </>
        )}
        <div className={s.headActions}>
          <Link className={buttonClass('secondary', 'sm')} to={`/analytics/scenarios/${projectId}/compare?ids=${sc.id}`}>
            <Icon name="columns" />
            Compare
          </Link>
          {!readOnly && (
            <Menu
              align="end"
              trigger={<IconButton icon="more-horizontal" label="More scenario actions" size="sm" />}
              items={[
                {
                  label: 'Duplicate',
                  icon: 'copy',
                  onSelect: () => void flush.current().then(() => duplicateScenario(projectId, sc.id, () => void client.invalidateQueries({ queryKey: ['scenario:list', projectId] }))),
                },
                { kind: 'separator' },
                { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDoomed(true) },
              ]}
            />
          )}
        </div>
      </div>
      {guard.changed && !readOnly && <ConflictBanner noun="scenario" onReload={onReload} onCopy={conflict.copy} />}
      <div className={s.main}>
        <ScenarioSetup
          projectId={projectId}
          draft={draft}
          metrics={metrics.data ?? []}
          targets={targets.data ?? null}
          result={res && res.ok ? res : null}
          onChange={setDraft}
        />
        {!res ? (
          <div className={s.results}>
            <SkeletonBlock label="Computing the scenario" />
          </div>
        ) : !res.ok && liveRefusalOf(res) !== null ? (
          // A metric on a Live dataset (L2.6): the server's reason — the copy is made from the dataset's own page.
          <div className={s.results}>
            <LiveRefusal title={LIVE_OFF.scenarios.title} message={`${LIVE_OFF.scenarios.why} ${liveRefusalOf(res) ?? ''}`} projectId={projectId} />
          </div>
        ) : !res.ok ? (
          <div className={s.results}>
            <ErrorState title="Could not compute the scenario" message={res.error} onRetry={() => void result.refetch()} />
          </div>
        ) : (
          <ScenarioResults res={res} busy={result.isFetching} onFocus={setFocus} />
        )}
      </div>
      <DeleteScenario
        projectId={projectId}
        scenario={{ id: sc.id, name: draft.name }}
        open={doomed}
        onOpenChange={setDoomed}
        onDeleted={() => {
          pending.current = null;
          void nav(`/analytics/scenarios/${projectId}`);
        }}
      />
    </div>
  );
}

export default function ScenarioPage() {
  const { projectId, scenarioId } = useParams();
  useAdoptProject(projectId);
  // The role decides whether a change is saved: never mount the editor before it is known, or an editor's first change is dropped.
  const roles = useRoles();
  const q = useQuery({
    queryKey: ['scenario:get', projectId, scenarioId],
    queryFn: async () => (await rpc('scenario:get', { projectId: projectId as string, id: scenarioId as string })) as Scenario | null,
    enabled: !!projectId && !!scenarioId,
    staleTime: Infinity,
    // A fresh read on every open: the draft and the tag its saves send come from one reply (docs/edit-conflicts).
    gcTime: 0,
  });
  const { gen, reload } = useReload(['scenario:get', projectId, scenarioId]);
  useDropOnLeave(['scenario:get', projectId, scenarioId]);
  if (!projectId || !scenarioId || q.isPending || roles.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <Page title="Scenario">
        <ErrorState title="That scenario could not be opened" message={q.error.message} onRetry={() => void q.refetch()} />
      </Page>
    );
  }
  if (!q.data) {
    return (
      <Page title="Scenario">
        <EmptyState
          icon="sliders"
          title="That scenario could not be opened"
          actions={
            <Link className={buttonClass('primary')} to={`/analytics/scenarios/${projectId}`}>
              All scenarios
            </Link>
          }
        >
          It may have been deleted.
        </EmptyState>
      </Page>
    );
  }
  const role = roles.data?.[projectId];
  return <Editor key={`${q.data.id}:${gen}`} projectId={projectId} sc={q.data} readOnly={role !== 'editor' && role !== 'admin'} onReload={reload} />;
}

