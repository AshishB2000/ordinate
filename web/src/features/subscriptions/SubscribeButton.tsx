// The dashboard head's Subscribe action. The dialog is its own lazy chunk, so a
// dashboard that nobody subscribes to never loads it.

import { lazy, Suspense, useState } from 'react';
import { Button } from '../../ui/Button';
import { useEditor } from '../analyses/editor/context';

const SubscribeDialog = lazy(() => import('./SubscribeDialog'));

/** Shown to editors: making a subscription is a write on the project. */
export function SubscribeButton() {
  const ed = useEditor();
  const [open, setOpen] = useState(false);
  if (ed.readOnly) return null;
  return (
    <>
      <Button
        size="sm"
        icon="send"
        title="Post this dashboard to Slack or Teams on a schedule"
        onClick={() => {
          ed.save.retry(); // what is on screen is what gets sent
          setOpen(true);
        }}
      >
        Subscribe
      </Button>
      {open && (
        <Suspense fallback={null}>
          <SubscribeDialog projectId={ed.projectId} dashboard={{ id: ed.analysisId, name: ed.doc.name }} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
