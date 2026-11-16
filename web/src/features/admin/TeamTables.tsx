// Admin → Teams → <team> → Tables (docs/team-folders/00-design.md, "Connection tables per team"): which warehouse tables
// this team's project viewers may ask the Assistant about, per project. Editors and admins already answer from every
// table; nothing is ticked until an admin ticks it. A ticked table reaches viewers only under the name an editor writes
// for them here, never its warehouse name. Its own URL (`?tab=teams&team=<id>`), so a link opens it.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { useConnections } from '../connections/api';
import { useSourceTables } from '../model/sources/api';
import { useAdminProjects, type Team } from './api';
import { useSaveTicks, useTeamTables, type Tick } from './teamTablesApi';
import { ConnectionTables } from './TeamTablesTree';
import a from './Admin.module.css';
import s from './TeamTables.module.css';

function ProjectTables({ projectId, projectName, team }: { projectId: string; projectName: string; team: Team }) {
  const ticks = useTeamTables(projectId, team.id);
  const conns = useConnections(projectId);
  const docs = useSourceTables(projectId);
  const save = useSaveTicks(projectId, team.id);
  const [draft, setDraft] = useState<Tick[] | null>(null); // the click's ticks, until the server's are read back
  if (ticks.isPending || conns.isPending) return <SkeletonTable cols={2} rows={4} label="Loading tables" />;
  if (ticks.isError) return <ErrorState heading={3} title="This team's tables could not be loaded" message={ticks.error.message} onRetry={() => void ticks.refetch()} />;
  if (conns.isError) return <ErrorState heading={3} title="Connections could not be loaded" message={conns.error.message} onRetry={() => void conns.refetch()} />;
  const change = (connId: string) => (next: Tick[]) => {
    setDraft(next);
    save(connId, next, { onError: (e) => toast(e instanceof Error ? e.message : 'The tables could not be saved.', { kind: 'error' }), onSettled: () => setDraft(null) });
  };
  return (
    <>
      {ticks.data.role === null && (
        <div className={`${a.notice} ${a.noticeWarn}`} role="status">
          <Icon name="alert" />
          <div>
            <h3 className={a.noticeTitle}>{team.name} has no role on {projectName}</h3>
            <p className={a.lead}>Its ticks give nothing until the project is shared with the team. Share it from the project, then come back.</p>
          </div>
        </div>
      )}
      {conns.data.length === 0 ? (
        <EmptyState heading={3} icon="plug" title="No connections in this project">
          Tables come from a project's connections. Add one under Connections, then tick its tables here.
        </EmptyState>
      ) : (
        <div className={s.conns}>
          {conns.data.map((c) => (
            <ConnectionTables
              key={c.id}
              projectId={projectId}
              conn={c}
              ticks={draft ?? ticks.data.rows}
              docs={docs.data?.connections.find((x) => x.connId === c.id)?.rows ?? []}
              onChange={change(c.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function TeamTables({ team, onBack }: { team: Team; onBack: () => void }) {
  const projects = useAdminProjects();
  const live = (projects.data ?? []).filter((p) => !p.archived);
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = picked ?? live[0]?.id ?? null;
  let body;
  if (projects.isPending) body = <SkeletonTable cols={2} rows={4} label="Loading projects" />;
  else if (projects.isError) body = <ErrorState heading={3} title="Projects could not be loaded" message={projects.error.message} onRetry={() => void projects.refetch()} />;
  else if (!projectId) body = <EmptyState heading={3} icon="folder" title="No projects yet">Tables are given per project. Create a project first.</EmptyState>;
  else body = <ProjectTables key={projectId} projectId={projectId} projectName={live.find((p) => p.id === projectId)?.name ?? ''} team={team} />;
  return (
    <section className={a.section} aria-label={`${team.name} tables`}>
      <div className={s.head}>
        <Button size="sm" variant="ghost" icon="arrow-left" onClick={onBack}>
          Teams
        </Button>
        <h2 className={s.title}>{team.name} · Tables</h2>
        <p className={a.lead}>
          Tick the warehouse tables this team's viewers may ask the Assistant about. Editors and admins already answer from every table. A ticked table reaches viewers
          only under the name you give it here, never its warehouse name.
        </p>
      </div>
      <div className={s.bar}>
        {live.length > 0 && (
          <Select label="Project" className={s.project} value={projectId} onValueChange={setPicked} options={live.map((p) => ({ value: p.id, label: p.name }))} />
        )}
        <div className={a.notice} role="note">
          <Icon name="info" />
          <p>Everyone in this team sees every row of these tables. To limit rows, make a dataset and give it row access rules.</p>
        </div>
      </div>
      {body}
    </section>
  );
}
