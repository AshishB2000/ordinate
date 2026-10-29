// Home — homePage.ts, homeAsk.ts and getStarted.ts, ported. ASK FIRST: after
// the greeting comes the ask hero (a tinted panel the page's full measure —
// asking is what Home is for) and its starter questions as cards, then the
// Get-started card while first-run guidance lasts, then ONE column — "Jump
// back in" (the newest records as preview cards), what the app found in the
// data, the open comments, and the table of all recent work. Bringing data in
// is the New menu's, so nothing on the page repeats it.
//
// The project Home speaks for is the current one — the top bar's switcher's
// (../projects/current), as on every project-scoped screen.

import { useNavigate } from 'react-router';
import { useOverview, useRecent } from '../../api/home';
import { openDockWith } from '../assistant/dockState';
import { useMe } from '../auth/api';
import { useCanEdit, type ProjectRow } from '../projects/api';
import { useCurrentProject } from '../projects/current';
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
import { MentionedYou } from '../dashboards/MentionedYou';

function Subtitle({ project, failed, loading }: { project: ProjectRow | null; failed: boolean; loading: boolean }) {
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

/** Dashboard opens the new-dashboard wizard and Visual its section; each way of bringing data in opens its own door, in Home's project. */
function NewMenu({ projectId }: { projectId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <Menu
      align="end"
      label="New"
      trigger={
        // Not the accent: on an ask-first page that is the hero's send button.
        <Button variant="secondary" icon="plus" iconEnd="chevron-down">
          New
        </Button>
      }
      items={[
        // The wizard, as the palette's "New dashboard" (the Dashboards section lists published pages).
        { label: 'Dashboard', icon: 'layout-dashboard', onSelect: () => void navigate(projectId ? `/dashboards?project=${projectId}&new=1` : '/dashboards?new=1') },
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
  const cur = useCurrentProject();
  const project = cur.project;
  const projectId = cur.projectId ?? undefined;
  const ov = useOverview(projectId);
  const recent = useRecent();
  // New and "Bring in some data" change the project: an editor's.
  const canEdit = useCanEdit(projectId);
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
          <Subtitle project={project} failed={cur.status === 'error'} loading={cur.status === 'pending'} />
        </div>
        <div className={s.headActions}>
          <GetStartedPill />
          {canEdit && <NewMenu projectId={projectId} />}
        </div>
      </header>
      <AskBar prompts={prompts} onAsk={openDockWith} />
      <GetStarted />
      {cur.status === 'success' && !project && (
        <div className={s.emptyBox}>
          <NoProject why="Your data, visuals and dashboards live in a project." />
        </div>
      )}
      {cur.status === 'error' && <ErrorState compact heading={2} title="Your projects could not be loaded" message="Check your connection and try again." onRetry={cur.refetch} />}
      <JumpBackIn projectId={projectId} recent={recent} />
      {/* What the app FOUND in the project's data (T2.11); renders nothing when nothing stands out. */}
      <WhatStandsOut projectId={projectId} />
      {/* The comments that name YOU, across your projects (docs/notifications); nothing without a user directory. */}
      <MentionedYou />
      {project && ov.data && <RecentComments projectId={project.id} comments={ov.data.comments} />}
      <RecentTable projectId={projectId} recent={recent} canEdit={canEdit} />
    </div>
  );
}
