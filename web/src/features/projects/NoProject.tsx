// The "no project yet" state every project-scoped page shows. Someone who may
// create a project (an org admin or editor) gets the switcher's own New project
// dialog right here; anyone else is told nothing has been shared with them.

import { lazy, Suspense, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useCanCreateProject, useCurrentProject } from './current';

const NewProjectDialog = lazy(() => import('./ProjectDialogs').then((m) => ({ default: m.NewProjectDialog })));

/** `why` is the page's one sentence on what a project holds for it ("Datasets live in a project."). */
export function NoProject({ why, heading = 2 }: { why: string; heading?: 2 | 3 }) {
  const canCreate = useCanCreateProject();
  const { select } = useCurrentProject();
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  // The server makes the first project with the bundled sample dataset and its dashboard (`sample:seed`).
  const startWithSample = () => {
    setSeeding(true);
    rpc('sample:seed')
      .then((r) => {
        const made = r as { ok: boolean; projectId?: string; analysisId?: string; error?: string };
        for (const key of ['projects:overview', 'projects:roles', 'projects:list']) void client.invalidateQueries({ queryKey: [key] });
        if (!made.ok || !made.projectId) {
          toast(made.error === 'has_projects' ? 'Your organization already has a project.' : 'The sample data could not be added.', { kind: 'error' });
          return;
        }
        select(made.projectId);
        toast('Sample data added. Delete it whenever you like.', { kind: 'success' });
        if (made.analysisId) void navigate(`/analyses/${made.projectId}/${made.analysisId}`);
      })
      .catch(() => toast('The sample data could not be added.', { kind: 'error' }))
      .finally(() => setSeeding(false));
  };
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
          <>
            <Button variant="primary" icon="plus" disabled={seeding} onClick={() => setCreating(true)}>
              New project
            </Button>
            <Button loading={seeding} onClick={startWithSample}>
              Start with sample data
            </Button>
          </>
        }
      >
        {why} Create one, or start with sample data to look around.
      </EmptyState>
      {creating && (
        <Suspense fallback={null}>
          <NewProjectDialog onClose={() => setCreating(false)} onCreated={select} />
        </Suspense>
      )}
    </>
  );
}
