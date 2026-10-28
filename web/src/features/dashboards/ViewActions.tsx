// The view page's own header actions (/dashboards/<p>/<id>). An editor shares by publishing: Share link opens the
// Publish dialog on the Dashboards page's Shared links tab with this dashboard picked, and Edit opens the editing
// screen. A viewer cannot publish (`publish:run` is write), so theirs is Copy link: this page's in-app address, which
// anyone in the project can open.

import { Link, useNavigate } from 'react-router';
import { Button, buttonClass } from '../../ui/Button';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { useEditor } from '../analyses/editor/context';
import { useCanEdit } from '../projects/api';

export function ViewActions() {
  const ed = useEditor();
  const navigate = useNavigate();
  const canEdit = useCanEdit(ed.projectId);
  if (!canEdit) {
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
  return (
    <>
      <Button size="sm" icon="globe" onClick={() => void navigate(`/dashboards?project=${ed.projectId}&dashboard=${ed.analysisId}`)}>
        Share link
      </Button>
      <Link className={buttonClass('secondary', 'sm')} to={`/analyses/${ed.projectId}/${ed.analysisId}`}>
        <Icon name="pencil" />
        <span>Edit</span>
      </Link>
    </>
  );
}
