// /connections/:projectId — Connect data (legacy connections.ts + connNew.ts +
// connRun.ts): the project's saved connections above, the 35-source picker
// below, and the chosen source's form in its place. `?source=<id>` lands
// straight on one source's form (the desktop's sidebar shortcuts), and is
// what "Change source" clears. /connections alone shows the first project.

import { useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useProjects } from '../../api/projects';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
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
  const projects = useProjects();
  if (projects.isPending) return <PageSkeleton />;
  if (projects.isError) {
    return (
      <Page title={TITLE}>
        <ErrorState title="Projects could not be loaded" message={projects.error.message} onRetry={() => void projects.refetch()} />
      </Page>
    );
  }
  if (projects.data.length === 0) {
    return (
      <Page title={TITLE} sub={SUB}>
        <EmptyState icon="folder" title="No project to connect into">
          A connection belongs to a project, and its datasets land there. Create a project first, then come back here.
        </EmptyState>
      </Page>
    );
  }
  // /connections shows the first project in place (no redirect: the nav item
  // stays on its own route); an unknown id falls back to it.
  if (projectId && !projects.data.some((p) => p.id === projectId)) return <Navigate to="/connections" replace />;
  return <Connect projectId={projectId ?? projects.data[0].id} projects={projects.data} />;
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

  function saved(c: Connection) {
    if (chosen) setDrafts(({ [chosen.id]: _gone, ...rest }) => rest);
    refreshLists();
    toast(`Connected “${c.name}”.`, { kind: 'success' });
    // Saving a connection is never the goal — querying it is.
    void navigate(`/connections/${projectId}/${c.id}`);
  }

  return (
    <Page title={TITLE} sub={SUB}>
      <div className={s.toolbar}>
        <Select
          aria-label="Project"
          className={s.project}
          value={projectId}
          onValueChange={(id) => void navigate(`/connections/${id}`)}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
        />
      </div>

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
