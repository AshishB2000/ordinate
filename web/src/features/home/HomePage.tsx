// Home — homePage.ts, homeAsk.ts and getStarted.ts, ported. ASK FIRST: after
// the greeting comes the ask hero (a tinted panel the page's full measure —
// asking is what Home is for) with its suggestion chips, then "Your numbers"
// (the metrics this person follows, as tiles), then the Get-started
// card while first-run guidance lasts, then ONE column: "Starred" (the
// caller's pins as preview cards), the freshness of the data that refreshes on
// its own, what the app found in the data, the open
// comments, and the table of all recent work. Bringing data in
// is the New menu's, so nothing on the page repeats it. A mention of you is the
// top bar bell's, on every page, not a section here.
//
// The project Home speaks for is the current one — the top bar's switcher's
// (../projects/current), as on every project-scoped screen.

import { useNavigate } from 'react-router';
import { useOverview, useRecent } from '../../api/home';
import { ASSISTANT_PATH } from '../assistant/DockParts';
import { askOnPage, runOnPage } from '../assistant/dockState';
import { useMe } from '../auth/api';
import { useCanEdit } from '../projects/api';
import { useCurrentProject } from '../projects/current';
import type { VerifiedChip } from '../assistant/api';
import { NoProject } from '../projects/NoProject';
import { Button } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { ErrorState } from '../../ui/States';
import { AskBar } from './AskBar';
import { GetStarted, GetStartedPill } from './GetStarted';
import { displayName, greeting, importPath, suggestPrompts, type Starter } from './homeText';
import { StarredRow } from './StarredRow';
import { DataFreshness } from './DataFreshness';
import { YourNumbers } from './YourNumbers';
import { RecentTable } from './RecentTable';
import { WhatStandsOut } from '../analytics/insights/WhatStandsOut';
import s from './HomePage.module.css';
import { RecentComments } from '../dashboards/RecentComments';

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
  const navigate = useNavigate();
  const me = useMe();
  const cur = useCurrentProject();
  const project = cur.project;
  const projectId = cur.projectId ?? undefined;
  const ov = useOverview(projectId);
  const recent = useRecent();
  // New and "Bring in some data" change the project: an editor's.
  const canEdit = useCanEdit(projectId);
  // Building is offered only to an editor; asking is anyone's.
  const prompts = suggestPrompts(ov.data?.datasets ?? [], canEdit);
  // Asked on the Assistant's own page, full width. A suggestion points it at the dataset it names, in Home's project.
  const ask = (q: string, about?: Starter['about']) => {
    askOnPage(q, about && projectId ? { projectId, context: { kind: 'dataset', id: about.id, label: `dataset · ${about.name}`, name: about.name } } : undefined);
    void navigate(ASSISTANT_PATH);
  };
  const run = (c: VerifiedChip) => {
    if (!projectId) return;
    runOnPage({ projectId, spec: c.spec, label: c.question });
    void navigate(ASSISTANT_PATH);
  };
  return (
    <div className={s.scroll}>
      <header className={s.head}>
        <div className={s.greetBlock}>
          {/* The page's name for the outline and the tab, like every section's; the greeting is what shows. */}
          <h1 className={s.srOnly}>Home</h1>
          <p className={s.greet} data-testid="home-greet">
            {greeting(displayName(me.data?.user?.email), new Date().getHours())}
          </p>
        </div>
        <div className={s.headActions}>
          <GetStartedPill />
          {canEdit && <NewMenu projectId={projectId} />}
        </div>
      </header>
      <AskBar prompts={prompts} onAsk={ask} projectId={projectId} onRun={run} />
      <YourNumbers projectId={projectId} />
      <GetStarted noData={ov.isSuccess && ov.data.datasets.length === 0} />
      {cur.status === 'success' && !project && (
        <div className={s.emptyBox}>
          <NoProject why="Your data, visuals and dashboards live in a project." />
        </div>
      )}
      {cur.status === 'error' && <ErrorState compact heading={2} title="Your projects could not be loaded" message="Check your connection and try again." onRetry={cur.refetch} />}
      <StarredRow projectId={projectId} recent={recent} />
      <DataFreshness projectId={projectId} />
      {/* What the app FOUND in the project's data (T2.11); renders nothing when nothing stands out. */}
      <WhatStandsOut projectId={projectId} />
      {project && ov.data && <RecentComments projectId={project.id} comments={ov.data.comments} />}
      <RecentTable projectId={projectId} recent={recent} canEdit={canEdit} />
    </div>
  );
}
