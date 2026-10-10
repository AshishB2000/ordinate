// Home's right column — homeData.ts, ported: "Your data" (the project's
// datasets over the Connect shortcuts) and "Saved visuals" (hidden when the
// project has none). Both come from ONE `home:overview` read, which also
// carries the greeting's counts.
//
// Changed from the desktop: the visual tiles show the chart type's glyph, not
// a live thumbnail — the thumbnail engine (vizThumbs) is T2.7's. Each Connect
// shortcut opens its own door: the import page on that source, or Connections.
// The screenshot hotkey is gone (no OS capture in a browser).

import { Link } from 'react-router';
import { useOverview, type HomeOverview } from '../../api/home';
import type { Project } from '../../api/projects';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { importPath, plural, qualityLabel } from './homeText';
import s from './HomePage.module.css';

/** `source`: the import page's `?source=`; none = the project's Connections. */
const CONNECT: { label: string; icon: IconName; source?: 'file' | 'paste' | 'screenshot' }[] = [
  { label: 'CSV / Excel', icon: 'file-text', source: 'file' },
  { label: 'Paste data', icon: 'clipboard', source: 'paste' },
  { label: 'Database', icon: 'database' },
  { label: 'Screenshot', icon: 'camera', source: 'screenshot' },
];

/** A chart id → the closest glyph in the icon set. */
function chartIcon(type: string): IconName {
  if (/line|spark|slope|step/.test(type)) return 'chart-line';
  if (/area|stream/.test(type)) return 'chart-area';
  if (/pie|donut|sunburst|radial/.test(type)) return 'chart-pie';
  if (/map|choropleth|geo|bubble_map/.test(type)) return 'map';
  if (/table|pivot|cohort/.test(type)) return 'table';
  if (/kpi|gauge|metric/.test(type)) return 'gauge';
  if (/scatter|bubble/.test(type)) return 'target';
  return 'chart-bar';
}

const noData = (canEdit: boolean) => <p className={s.dataEmpty}>{canEdit ? 'No datasets yet — connect one below.' : 'No datasets yet.'}</p>;

function DataList({ data, projectId, canEdit }: { data: HomeOverview; projectId: string; canEdit: boolean }) {
  if (!data.datasets.length) return noData(canEdit);
  return (
    <ul className={s.dataList}>
      {data.datasets.map((d) => {
        const dq = qualityLabel(d.qualityFailing);
        return (
          <li key={d.id}>
            <Link className={s.dataRow} to={`/data/${projectId}/${d.id}`}>
              <span className={s.dataName}>
                {dq && <span className={s.dq} role="img" aria-label={dq} title={dq} />}
                {d.name || 'Untitled dataset'}
              </span>
              <span className={s.dataMeta}>
                {plural(d.rowCount, 'row')} × {plural(d.columnCount, 'col')}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function SideColumn({
  project,
  canEdit,
  projectsFailed,
  retryProjects,
}: {
  project: Project | undefined;
  /** An editor of `project`: the Connect shortcuts are theirs. */
  canEdit: boolean;
  projectsFailed: boolean;
  retryProjects: () => void;
}) {
  const ov = useOverview(project?.id);
  let body;
  if (projectsFailed) {
    body = <ErrorState compact heading={3} title="Your projects could not be loaded" message="Check your connection and try again." onRetry={retryProjects} />;
  } else if (!project) {
    body = noData(canEdit);
  } else if (ov.isPending) {
    body = <SkeletonRows rows={3} label="Loading your data" />;
  } else if (ov.isError) {
    body = <ErrorState compact heading={3} title="Your data could not be loaded" message={ov.error.message} onRetry={() => void ov.refetch()} />;
  } else {
    body = <DataList data={ov.data} projectId={project.id} canEdit={canEdit} />;
  }
  const visuals = ov.data?.visuals ?? [];
  return (
    <aside className={s.colSide} aria-label="This project">
      <section className={s.card} aria-labelledby="home-data">
        <h2 id="home-data" className={s.cardH}>
          Your data
        </h2>
        {body}
        {canEdit && (
          <div className={s.connect}>
            <span className={s.quickLabel}>Connect</span>
            <div className={s.quickRow}>
              {CONNECT.map((c) => (
                <Link key={c.label} className={s.quickBtn} to={c.source ? importPath(project?.id, c.source) : project ? `/connections/${project.id}` : '/connections'}>
                  <Icon name={c.icon} />
                  {c.label}
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>
      {visuals.length > 0 && (
        <section className={s.card} aria-labelledby="home-viz">
          <h2 id="home-viz" className={s.cardH}>
            Saved visuals
          </h2>
          <ul className={s.vizStrip}>
            {visuals.map((v) => (
              <li key={v.id}>
                <Link className={s.vizCard} to="/visuals" aria-label={v.name || 'Untitled visual'}>
                  <span className={s.vizTile} aria-hidden="true">
                    <Icon name={chartIcon(v.chartType)} size={24} />
                  </span>
                  <span className={s.vizName}>{v.name || 'Untitled visual'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
