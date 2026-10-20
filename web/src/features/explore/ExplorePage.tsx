// /explore (docs/explore/00-design.md) — a place to ask a question of the
// current project's data, for everyone, with no AI model needed. This file is
// the gates and their designed states: projects loading or failed, no project,
// datasets loading or failed, no datasets (an editor's import doors, a viewer's
// sentence). Then the URL is made whole — `?project=&dataset=` — and the
// workbench (./Explorer) takes over.

import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useDatasets } from '../../api/datasets';
import { ErrorState, Page } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Skeleton } from '../../ui/Skeleton';
import { importPath } from '../home/homeText';
import { useRoles } from '../projects/api';
import { useCurrentProject } from '../projects/current';
import { NoProject } from '../projects/NoProject';
import { VizIcon } from '../visuals/VizIcon';
import { Explorer } from './Explorer';
import s from './Explore.module.css';
import cards from './Start.module.css';

const TITLE = 'Explore';
const SUB = 'Ask a question of your data: pick fields, or start from a suggestion. Every figure is computed by the app.';

export default function ExplorePage() {
  const cur = useCurrentProject();
  if (cur.status === 'pending') return <ExploreSkeleton />;
  if (cur.status === 'error') {
    return (
      <Page title={TITLE}>
        <ErrorState title="Projects could not be loaded" message={cur.error?.message ?? ''} onRetry={cur.refetch} />
      </Page>
    );
  }
  if (!cur.projectId) {
    return (
      <Page title={TITLE} sub={SUB}>
        <NoProject why="Explore asks questions of a project’s datasets." />
      </Page>
    );
  }
  return <ProjectExplore key={cur.projectId} projectId={cur.projectId} />;
}

function ProjectExplore({ projectId }: { projectId: string }) {
  const datasets = useDatasets(projectId);
  const [params, setParams] = useSearchParams();
  const asked = params.get('dataset');
  const list = datasets.data ?? [];
  const dataset = list.find((d) => d.id === asked) ?? list[0];

  // The URL names the project and the dataset on screen, so a copied link opens them. A question
  // asked of another dataset (or of one that is gone) does not survive the switch: its fields differ.
  const id = dataset?.id;
  const named = params.get('project');
  useEffect(() => {
    if (!id || (named === projectId && asked === id)) return;
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set('project', projectId);
        n.set('dataset', id);
        if (asked && asked !== id) n.delete('q');
        return n;
      },
      { replace: true },
    );
  }, [id, named, asked, projectId, setParams]);

  if (datasets.isPending) return <ExploreSkeleton />;
  if (datasets.isError) {
    return (
      <Page title={TITLE}>
        <ErrorState title="Datasets could not be loaded" message={datasets.error.message} onRetry={() => void datasets.refetch()} />
      </Page>
    );
  }
  if (!dataset) return <NoData projectId={projectId} />;
  return <Explorer key={dataset.id} projectId={projectId} datasets={list} dataset={dataset} />;
}

/** No dataset yet: what Explore will do, and — for an editor — the doors that bring data in. */
function NoData({ projectId }: { projectId: string }) {
  // Asked once, and waited for: an editor never reads the viewer's sentence first.
  const roles = useRoles();
  const role = roles.data?.[projectId];
  const canEdit = role === 'editor' || role === 'admin';
  return (
    <Page title={TITLE} sub={SUB}>
      <section className={s.blank} aria-labelledby="explore-blank">
        <div className={s.blankArt} aria-hidden="true">
          {['bar', 'line', 'donut', 'scatter'].map((t, i) => (
            <span key={t} className={i === 1 ? `${s.blankGlyph} ${s.blankFocus}` : s.blankGlyph}>
              <VizIcon type={t} />
            </span>
          ))}
        </div>
        <h2 id="explore-blank" className={s.blankH}>
          No data to explore yet
        </h2>
        <p className={s.blankP}>Explore answers questions about this project’s datasets with charts and tables the app computes — no AI model needed.</p>
        <ul className={s.blankAsk} aria-label="Questions you will be able to ask">
          {['Total revenue by region', 'Orders by month', 'Average discount by segment'].map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
        {roles.isSuccess && !canEdit && <p className={s.blankP}>An editor of this project can bring in data. You have view-only access.</p>}
        {canEdit && (
          <div className={s.blankActions}>
            <Link className={buttonClass('primary', 'lg')} to={importPath(projectId)}>
              <Icon name="upload" />
              <span>Import data</span>
            </Link>
            <Link className={buttonClass('secondary', 'lg')} to={`/connections/${projectId}`}>
              <Icon name="plug" />
              <span>Connect a database</span>
            </Link>
          </div>
        )}
      </section>
    </Page>
  );
}

/** The workbench arriving: the title, a rail of fields, the wells and the suggestion cards — so nothing jumps when it lands. */
function ExploreSkeleton() {
  return (
    <div className={s.page} role="status" aria-busy="true" aria-label="Loading Explore">
      <div className={s.head} aria-hidden="true">
        <Skeleton className={s.skTitle} />
        <Skeleton className={s.skSub} />
      </div>
      <div className={s.bench} aria-hidden="true">
        <div className={s.rail}>
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className={s.skRow} />
          ))}
        </div>
        <div className={s.main}>
          <Skeleton className={s.skWells} />
          <div className={cards.cards}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className={cards.cardSkel} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
