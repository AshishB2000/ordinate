// The view page's own header action (/dashboards/<p>/<id>): Copy link, for everyone. It copies this page's live
// in-app address, which anyone in the project can open. Editing lives in Analyses only, and the published /p/
// snapshot is not offered from here.

import { Button } from '../../ui/Button';
import { toast } from '../../ui/Toast';
import { useEditor } from '../analyses/editor/context';

export function ViewActions() {
  const ed = useEditor();
  const copy = () =>
    navigator.clipboard.writeText(`${window.location.origin}/dashboards/${ed.projectId}/${ed.analysisId}`).then(
      () => toast('Link copied', { kind: 'success' }),
      () => toast('The clipboard is not available here.', { kind: 'error' }),
    );
  return (
    <Button size="sm" icon="link" onClick={() => void copy()}>
      Copy link
    </Button>
  );
}
