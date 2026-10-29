// The strip over a Preview: the view page drawing the DRAFT (/dashboards/<p>/<id>?draft=1, or a dashboard never
// published opened there by an editor — the server answers `showing: 'draft'`). Back to editing, or Publish. A viewer
// is always sent the published copy, so they never see it.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, buttonClass } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { useEditor } from '../../analyses/editor/context';
import { useCanEdit } from '../../projects/api';
import { PublishDraftDialog } from './PublishDraft';
import { useOpened } from './state';
import s from './Drafts.module.css';

export function PreviewStrip() {
  const ed = useEditor();
  const opened = useOpened(ed);
  const canEdit = useCanEdit(ed.projectId);
  const navigate = useNavigate();
  const [publishing, setPublishing] = useState(false);
  if (!canEdit || opened?.showing !== 'draft') return null;
  return (
    <div className={s.preview} role="region" aria-label="Preview">
      <Icon name="eye" />
      <p className={s.previewText}>
        <strong>Preview.</strong> This is how viewers will see this dashboard once you publish it.
      </p>
      <div className={s.stripActions}>
        <Link className={buttonClass('secondary', 'sm')} to={`/analyses/${ed.projectId}/${ed.analysisId}`}>
          <Icon name="pencil" />
          <span>Back to editing</span>
        </Link>
        <Button size="sm" variant="primary" icon="upload" onClick={() => setPublishing(true)}>
          {opened.status === 'edited' ? 'Publish changes' : 'Publish'}
        </Button>
      </div>
      {publishing && (
        <PublishDraftDialog onClose={() => setPublishing(false)} onPublished={() => void navigate(`/dashboards/${ed.projectId}/${ed.analysisId}`, { replace: true })} />
      )}
    </div>
  );
}
