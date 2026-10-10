// The "no project yet" state every project-scoped page shows. Someone who may
// create a project (an org admin or editor) gets the switcher's own New project
// dialog right here; anyone else is told nothing has been shared with them.

import { lazy, Suspense, useState } from 'react';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/States';
import { useCanCreateProject, useCurrentProject } from './current';

const NewProjectDialog = lazy(() => import('./ProjectDialogs').then((m) => ({ default: m.NewProjectDialog })));

/** `why` is the page's one sentence on what a project holds for it ("Datasets live in a project."). */
export function NoProject({ why, heading = 2 }: { why: string; heading?: 2 | 3 }) {
  const canCreate = useCanCreateProject();
  const { select } = useCurrentProject();
  const [creating, setCreating] = useState(false);
  if (!canCreate) {
    return (
      <EmptyState heading={heading} icon="folder" title="No project yet">
        Nothing has been shared with you yet. Ask a project admin for access.
      </EmptyState>
    );
  }
  return (
    <>
      <EmptyState
        heading={heading}
        icon="folder"
        title="No project yet"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            New project
          </Button>
        }
      >
        {why} Create one to get started.
      </EmptyState>
      {creating && (
        <Suspense fallback={null}>
          <NewProjectDialog onClose={() => setCreating(false)} onCreated={select} />
        </Suspense>
      )}
    </>
  );
}
