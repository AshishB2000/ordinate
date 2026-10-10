// Home — homePage.ts, homeAsk.ts and getStarted.ts, ported. In weight order:
// the greeting, the ASK BAR (the one dominant element), the Get-started card
// while first-run guidance lasts, then ONE column the page's full measure —
// "Jump back in" (the newest records as preview cards), what the app found in
// the data, the open comments, and the table of all recent work. Bringing data
// in is the New menu's, so nothing on the page repeats it.
//
// The project Home speaks for is the most recently updated one the caller can
// read (projects:list comes newest first). T2.2's switcher will make it the
// session's chosen project instead.

import { useNavigate } from 'react-router';
import { useOverview, useRecent } from '../../api/home';
import { useProjects, type Project } from '../../api/projects';
import { openDockWith } from '../assistant/dockState';
import { useMe } from '../auth/api';
import { useCanEdit } from '../projects/api';
import { NoProject } from '../projects/NoProject';
import { Button } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { Skeleton } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { AskBar } from './AskBar';
import { GetStarted, GetStartedPill } from './GetStarted';
import { displayName, greeting, importPath, plural, suggestPrompts } from './homeText';
import { JumpBackIn } from './JumpBackIn';
import { RecentTable } from './RecentTable';
import { WhatStandsOut } from '../analytics/insights/WhatStandsOut';
import s from './HomePage.module.css';
import { RecentComments } from '../dashboards/RecentComments';

function homeProject(list: Project[] | undefined): Project | undefined {
  return list?.find((p) => !p.archivedAt) ?? list?.[0];
}

function Subtitle({ project, failed, loading }: { project: Project | undefined; failed: boolean; loading: boolean }) {
  const ov = useOverview(project?.id);
  if (loading) return <Skeleton className={s.subSk} />;
  if (failed) return <p className={s.sub}>Your projects could not be loaded.</p>;
  if (!project) return <p className={s.sub}>No project yet.</p>;
  const c = ov.data?.counts;
  const parts = [project.name || 'Untitled project'];
  // Captures only when there are any: a project that never took one is not told it has none.
  if (c) parts.push(plural(c.datasets, 'dataset'), plural(c.dashboards, 'dashboard'), ...(c.captures ? [plural(c.captures, 'capture')] : []));
  return (
    <p className={s.sub} data-testid="home-sub">
      {parts.join('  ·  ')}
    </p>
  );
}

/** Dashboard and Visual open their section; each way of bringing data in opens its own door, in Home's project. */
function NewMenu({ projectId }: { projectId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <Menu
      align="end"
      label="New"
      trigger={
        <Button variant="primary" icon="plus" iconEnd="chevron-down">
          New
        </Button>
      }
      items={[
        { label: 'Dashboard', icon: 'layout-dashboard', onSelect: () => void navigate('/dashboards') },
        { label: 'Visual', icon: 'chart-bar', onSelect: () => void navigate('/visuals') },
        { kind: 'separator' },
        { kind: 'heading', label: 'Add data' },
        { label: 'CSV / Excel', icon: 'file-text', onSelect: () => void navigate(importPath(projectId, 'file')) },
        { label: 'Paste data', icon: 'clipboard', onSelect: () => void navigate(importPath(projectId, 'paste')) },
        { label: 'Screenshot', icon: 'camera', onSelect: () => void navigate(importPath(projectId, 'screenshot')) },
        { label: 'Database', icon: 'database', onSelect: () => void navigate(projectId ? `/connections/${projectId}` : '/connections') },
      ]}
    />
  );
}

export default function HomePage() {
  const me = useMe();
  const projects = useProjects();
  const project = homeProject(projects.data);
  const ov = useOverview(project?.id);
  const recent = useRecent();
  // New and "Bring in some data" change the project: an editor's.
  const canEdit = useCanEdit(project?.id);
  const prompts = suggestPrompts(
    (ov.data?.datasets ?? []).map((d) => d.name),
    (recent.data ?? []).filter((r) => r.type === 'dataset').map((r) => r.name),
  );
  return (
    <div className={s.scroll}>
      <header className={s.head}>
        <div className={s.greetBlock}>
          {/* The page's name for the outline and the tab, like every section's; the greeting is what shows. */}
          <h1 className={s.srOnly}>Home</h1>
          <p className={s.greet} data-testid="home-greet">
            {greeting(displayName(me.data?.user?.email), new Date().getHours())}
          </p>
          <Subtitle project={project} failed={projects.isError} loading={projects.isPending} />
        </div>
        <div className={s.headActions}>
          <GetStartedPill />
          {canEdit && <NewMenu projectId={project?.id} />}
        </div>
      </header>
      <AskBar prompts={prompts} onAsk={openDockWith} />
      <GetStarted />
      {projects.isSuccess && !project && (
        <div className={s.emptyBox}>
          <NoProject why="Your data, visuals and dashboards live in a project." />
        </div>
      )}
      {projects.isError && <ErrorState compact heading={2} title="Your projects could not be loaded" message="Check your connection and try again." onRetry={() => void projects.refetch()} />}
      <JumpBackIn projectId={project?.id} recent={recent} />
      {/* What the app FOUND in the project's data (T2.11); renders nothing when nothing stands out. */}
      <WhatStandsOut projectId={project?.id} />
      {project && ov.data && <RecentComments projectId={project.id} comments={ov.data.comments} />}
      <RecentTable projectId={project?.id} recent={recent} canEdit={canEdit} />
    </div>
  );
}
