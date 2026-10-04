// /analytics/scenarios/:projectId — the project's what-if scenarios as cards
// (scenarioList.ts): name, the drivers in words, how many metrics; open one,
// compare up to four, duplicate, delete. On the desktop this was the Scenarios
// tab of Dashboards. Every figure is computed on the server.

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorState, Page, PageSkeleton } from '../../../app/blocks';
import { buttonClass, IconButton } from '../../../ui/Button';
import { Menu } from '../../../ui/Menu';
import { SkeletonRows } from '../../../ui/Skeleton';
import { Icon } from '../../../ui/icons/Icon';
import { useAdoptProject } from '../../projects/current';
import { useScenarios, type ScenarioSummary } from '../api';
import { DeleteScenario, DriverChips, NewScenario, TornadoArt, duplicateScenario } from './ScenarioParts';
import s from './Scenarios.module.css';

const when = (iso: string) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Card({ sc, projectId, onDelete, refresh }: { sc: ScenarioSummary; projectId: string; onDelete: () => void; refresh: () => void }) {
  const nav = useNavigate();
  const open = `/analytics/scenarios/${projectId}/${sc.id}`;
  return (
    <li className={s.card}>
      <Link className={s.cardLink} to={open} aria-label={`Open scenario ${sc.name}`}>
        <TornadoArt />
        <span className={s.cardBody}>
          <span className={s.cardTitle}>{sc.name || 'Untitled scenario'}</span>
          <span className={s.cardMeta}>{`${plural(sc.driverCount, 'driver', 'drivers')} · ${plural(sc.metricCount, 'metric', 'metrics')} · ${when(sc.updatedAt)}`}</span>
          <span className={s.cardDrivers}>
            <DriverChips names={sc.driverNames} none="No drivers yet — the baseline" />
          </span>
        </span>
      </Link>
      <span className={s.cardMore}>
        <Menu
          trigger={<IconButton icon="more-horizontal" label="Scenario actions" size="sm" />}
          align="end"
          items={[
            { label: 'Open', icon: 'external-link', onSelect: () => void nav(open) },
            { label: 'Compare…', icon: 'columns', onSelect: () => void nav(`/analytics/scenarios/${projectId}/compare?ids=${sc.id}`) },
            { label: 'Duplicate', icon: 'copy', onSelect: () => void duplicateScenario(projectId, sc.id, refresh) },
            { kind: 'separator' },
            { label: 'Delete', icon: 'trash', danger: true, onSelect: onDelete },
          ]}
        />
      </span>
    </li>
  );
}

function List({ projectId }: { projectId: string }) {
  const q = useScenarios(projectId);
  const client = useQueryClient();
  const [doomed, setDoomed] = useState<ScenarioSummary | null>(null);
  const refresh = () => void client.invalidateQueries({ queryKey: ['scenario:list', projectId] });
  const list = q.data ?? [];
  return (
    <Page title="Scenarios" sub="What-if: drivers move a metric’s inputs, never the stored data. Open one to tune it, or compare up to four side by side.">
      {q.isPending ? (
        <SkeletonRows rows={4} label="Loading scenarios" />
      ) : q.isError ? (
        <ErrorState title="Scenarios could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : list.length === 0 ? (
        <div className={s.empty}>
          <TornadoArt className={s.emptyArt} />
          <h2 className={s.emptyH}>No scenarios yet</h2>
          <p className={s.emptyP}>
            A scenario asks “what if?” of your metrics. Add drivers — a price up five percent, one region’s volume down three, a discount set to zero — and every metric is recomputed beside its baseline, with a chart of which driver moves it most. The stored data never changes.
          </p>
          <ul className={s.examples} aria-label="Example drivers">
            <li className={s.chip}>unit_price +5%</li>
            <li className={s.chip}>units in West −3%</li>
            <li className={s.chip}>discount = 0</li>
          </ul>
          <NewScenario projectId={projectId} size="lg" />
        </div>
      ) : (
        <>
          <div className={s.listBar}>
            <Link className={buttonClass('secondary')} to={`/analytics/scenarios/${projectId}/compare`}>
              <Icon name="columns" />
              Compare
            </Link>
            <NewScenario projectId={projectId} />
          </div>
          <ul className={s.grid} aria-label="Scenarios">
            {list.map((sc) => (
              <Card key={sc.id} sc={sc} projectId={projectId} refresh={refresh} onDelete={() => setDoomed(sc)} />
            ))}
          </ul>
        </>
      )}
      <DeleteScenario projectId={projectId} scenario={doomed} open={!!doomed} onOpenChange={(o) => !o && setDoomed(null)} onDeleted={() => setDoomed(null)} />
    </Page>
  );
}

export default function ScenariosPage() {
  const { projectId } = useParams();
  useAdoptProject(projectId);
  if (!projectId) return <PageSkeleton />;
  return <List projectId={projectId} />;
}
