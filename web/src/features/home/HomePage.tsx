// Home — homePage.ts, homeAsk.ts, homeData.ts and getStarted.ts, ported. In
// weight order: the greeting, the ASK BAR (the one dominant element), the
// Get-started card while first-run guidance lasts, then two columns — Starred
// and Recent on the left, "Your data" and "Saved visuals" on the right.
//
// The project Home speaks for is the most recently updated one the caller can
// read (projects:list comes newest first). T2.2's switcher will make it the
// session's chosen project instead.

import { useNavigate } from 'react-router';
import { useOverview, useRecent } from '../../api/home';
import { useProjects, type Project } from '../../api/projects';
import { openDockWith } from '../assistant/dockState';
import { useMe } from '../auth/api';
import { Button } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { Skeleton } from '../../ui/Skeleton';
import { AskBar } from './AskBar';
import { GetStarted, GetStartedPill } from './GetStarted';
import { displayName, greeting, plural, suggestPrompts } from './homeText';
import { RecentColumn } from './RecentColumn';
import { SideColumn } from './SideColumn';
import s from './HomePage.module.css';

function homeProject(list: Project[] | undefined): Project | undefined {
  return list?.find((p) => !p.archivedAt) ?? list?.[0];
}

function Subtitle({ project, failed, loading }: { project: Project | undefined; failed: boolean; loading: boolean }) {
  const ov = useOverview(project?.id);
  if (loading) return <Skeleton className={s.subSk} />;
  if (failed) return <p className={s.sub}>Your projects could not be loaded.</p>;
  if (!project) return <p className={s.sub}>No project yet — bring some data in to begin.</p>;
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

function NewMenu() {
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
        { label: 'Data source', icon: 'database', onSelect: () => void navigate('/data') },
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
          <NewMenu />
        </div>
      </header>
      <AskBar prompts={prompts} onAsk={openDockWith} />
      <GetStarted />
      <div className={s.cols}>
        <RecentColumn projectId={project?.id} recent={recent} />
        <SideColumn project={project} projectsFailed={projects.isError} retryProjects={() => void projects.refetch()} />
      </div>
    </div>
  );
}
