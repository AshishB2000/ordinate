// Home, shell edition: the project list from the API, with its loading,
// empty and error states. T2.1 ports the real Home (greeting, ask bar,
// recent, starred) on top of this.

import { useProjects, type Project } from '../../api/projects';
import { EmptyState, ErrorState, Page, SkeletonRows } from '../../app/blocks';
import s from './HomePage.module.css';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function ProjectRow({ p }: { p: Project }) {
  return (
    <li className={s.row}>
      <span className={s.avatar} aria-hidden="true">
        {p.name.trim().charAt(0).toUpperCase() || '·'}
      </span>
      <span className={s.name}>{p.name}</span>
      {p.archivedAt && <span className={s.badge}>Archived</span>}
      <time className={s.meta} dateTime={p.updatedAt}>
        Updated {dateFmt.format(new Date(p.updatedAt))}
      </time>
    </li>
  );
}

function Projects() {
  const q = useProjects();
  if (q.isPending) return <SkeletonRows label="Loading projects" />;
  if (q.isError) {
    return (
      <ErrorState title="Projects could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />
    );
  }
  if (q.data.length === 0) {
    return (
      <EmptyState icon="folder" title="No projects yet">
        A project groups datasets, visuals and dashboards that belong together. The first one is created when you
        bring in data.
      </EmptyState>
    );
  }
  return (
    <ul className={s.list}>
      {q.data.map((p) => (
        <ProjectRow key={p.id} p={p} />
      ))}
    </ul>
  );
}

export default function HomePage() {
  return (
    <Page title="Home" sub="Your projects on this server.">
      <section className={s.section} aria-labelledby="home-projects">
        <h2 id="home-projects" className={s.label}>
          Projects
        </h2>
        <Projects />
      </section>
    </Page>
  );
}
