// /connections/:projectId — Connect data (legacy connections.ts + connNew.ts +
// connRun.ts): the project's saved connections above, the 40-source picker
// below, and the chosen source's form in its place. `?source=<id>` lands
// straight on one source's form (the desktop's sidebar shortcuts), and is
// what "Change source" clears. /connections alone shows the current project.

import { useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { useAdoptProject, useCurrentProject } from '../projects/current';
import { EditorsOnly } from '../projects/EditorsOnly';
import { NoProject } from '../projects/NoProject';
import { useCatalog, useConnections, useLogos, useRefreshLists, type Connection } from './api';
import { ConnectionForm, initialDraft, type Draft } from './ConnectionForm';
import { ConnectorPicker } from './ConnectorPicker';
import { SavedConnections } from './SavedConnections';
import s from './Connections.module.css';

// The heading is the nav item's name (the shell spec holds every page to that);
// the desktop's "Connect data" leads the line under it.
const TITLE = 'Connections';
const SUB = 'Connect data: pick a source, fill in its details, and pull it into this project as a dataset. Every source is read-only.';

export default function ConnectionsPage() {
  const { projectId } = useParams();
  const cur = useCurrentProject();
  useAdoptProject(projectId); // the URL names the project: the switcher follows it
  if (cur.status === 'pending') return <PageSkeleton />;
  if (cur.status === 'error') {
    return (
      <Page title={TITLE}>
        <ErrorState title="Projects could not be loaded" message={cur.error?.message ?? 'Try again.'} onRetry={cur.refetch} />
      </Page>
    );
  }
  const live = cur.projects.filter((p) => !p.archived);
  if (!cur.projectId) {
    return (
      <Page title={TITLE} sub={SUB}>
        <NoProject why="A connection belongs to a project, and its datasets land there." />
      </Page>
    );
  }
  // /connections shows the current project in place (no redirect: the nav item
  // stays on its own route); an unknown id falls back to it.
  if (projectId && !live.some((p) => p.id === projectId)) return <Navigate to="/connections" replace />;
  const id = projectId ?? cur.projectId;
  return (
    <EditorsOnly
      projectId={id}
      page={TITLE}
      icon="plug"
      title="Connections are for editors"
      body="Connecting a source, querying it and saving its rows as a dataset are for editors of this project; the datasets a connection feeds are in Data."
      back={{ to: `/data/${id}`, label: 'Open Data' }}
      above={<ProjectPick projectId={id} projects={live} />}
    >
      <Connect projectId={id} projects={live} />
    </EditorsOnly>
  );
}

function ProjectPick({ projectId, projects }: { projectId: string; projects: { id: string; name: string }[] }) {
  const navigate = useNavigate();
  return (
    <div className={s.toolbar}>
      <Select
        aria-label="Project"
        className={s.project}
        value={projectId}
        onValueChange={(id) => void navigate(`/connections/${id}`)}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
      />
    </div>
  );
}

function Connect({ projectId, projects }: { projectId: string; projects: { id: string; name: string }[] }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const catalog = useCatalog();
  const logos = useLogos();
  const conns = useConnections(projectId);
  const refreshLists = useRefreshLists(projectId);

  const sourceId = params.get('source');
  const chosen = catalog.data?.find((d) => d.id === sourceId) ?? null;
  const choose = (id: string | null) => setParams(id ? { source: id } : {}, { replace: false });
  const logoMap = logos.data ?? {};

  function saved(c: Connection, warnings: string[]) {
    if (chosen) setDrafts(({ [chosen.id]: _gone, ...rest }) => rest);
    refreshLists();
    toast(`Connected “${c.name}”.`, { kind: 'success' });
    // Also shown, to stay, beside the rail's test result in the workbench.
    for (const w of warnings) toast(w, { kind: 'info' });
    // Saving a connection is never the goal — querying it is.
    void navigate(`/connections/${projectId}/${c.id}`);
  }

  return (
    <Page title={TITLE} sub={SUB}>
      <ProjectPick projectId={projectId} projects={projects} />

      {conns.isPending ? (
        <SkeletonRows rows={2} label="Loading saved connections" />
      ) : conns.isError ? (
        <ErrorState compact heading={3} title="Saved connections could not be loaded" message={conns.error.message} onRetry={() => void conns.refetch()} />
      ) : conns.data.length > 0 ? (
        <SavedConnections projectId={projectId} list={conns.data} catalog={catalog.data ?? []} logos={logoMap} onDeleted={refreshLists} />
      ) : (
        !chosen && <p className={s.muted}>No connections yet. Pick a source below to add one.</p>
      )}

      {catalog.isPending ? (
        <div className={s.tileSkeleton}>
          <SkeletonRows rows={6} label="Loading data sources" />
        </div>
      ) : catalog.isError ? (
        <ErrorState heading={3} title="The data sources could not be loaded" message={catalog.error.message} onRetry={() => void catalog.refetch()} />
      ) : chosen ? (
        <ConnectionForm
          key={chosen.id}
          def={chosen}
          logo={logoMap[chosen.id]}
          projectId={projectId}
          draft={drafts[chosen.id] ?? initialDraft(chosen)}
          onDraft={(d) => setDrafts({ ...drafts, [chosen.id]: d })}
          onBack={() => choose(null)}
          onSaved={saved}
        />
      ) : (
        <ConnectorPicker catalog={catalog.data} logos={logoMap} search={search} onSearch={setSearch} onPick={(d) => choose(d.id)} />
      )}
    </Page>
  );
}
