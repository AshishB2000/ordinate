// "Publish “<name>”?" — the confirmation before a draft goes in front of viewers (src/analysis/publishDashboard.ts).
// Not the /p/ shared-link dialog (../PublishDialog.tsx). It says what Publish does — everyone in the project sees it,
// they see THIS version until the next Publish, the figures stay live — and what goes (sheets, charts, KPIs, filters).
//
// What goes live is what the person looked at: the editor's publish waits for its pending save and sends the tag its
// saves reached, the Preview's sends the tag it opened with. A draft that moved since is refused (409 record_changed):
// the dialog says so and offers Reload, never a second try that would publish someone else's edits unseen.

import { useState } from 'react';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import { toast } from '../../../ui/Toast';
import { failure, useDraftActions } from '../../analyses/api';
import { useEditor, type EditorApi } from '../../analyses/editor/context';
import { isRecordChanged } from '../../editConflicts/useEditGuard';
import { useOverview } from '../../projects/api';
import { contentsOf, useOpened } from './state';
import s from './Drafts.module.css';

type Outcome = 'published' | 'changed' | 'unsaved';

/** Publish the draft this page shows, as it was seen. */
export function usePublish(ed: EditorApi, tag: string | undefined): () => Promise<Outcome> {
  const { publish } = useDraftActions(ed.projectId, ed.analysisId);
  return async () => {
    if (!ed.viewing) {
      // The editor: its last edit first, then Publish in the same queue with the tag that save reached. A save that
      // failed leaves edits only this screen has — publishing then would put an older draft live.
      await ed.save.flush();
      const r = await ed.save.send(async (base) => (ed.save.unsaved() ? ('unsaved' as const) : publish.mutateAsync(base)));
      return r === null ? 'changed' : r === 'unsaved' ? 'unsaved' : 'published';
    }
    try {
      await publish.mutateAsync(tag);
      return 'published';
    } catch (err) {
      if (isRecordChanged(err)) return 'changed';
      throw err;
    }
  };
}

function Point({ icon, title, children }: { icon: IconName; title: string; children: string }) {
  return (
    <li className={s.point}>
      <span className={s.pointIcon} aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span>
        <span className={s.pointTitle}>{title}</span>
        <span className={s.pointText}>{children}</span>
      </span>
    </li>
  );
}

export function PublishDraftDialog({ onClose, onPublished }: { onClose: () => void; onPublished?: () => void }) {
  const ed = useEditor();
  const opened = useOpened(ed);
  const publish = usePublish(ed, opened?.tag);
  const project = useOverview().data?.find((p) => p.id === ed.projectId)?.name;
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'ask' | 'changed' | 'unsaved'>('ask');
  const [error, setError] = useState('');
  const verb = opened?.status === 'edited' ? 'Publish changes' : 'Publish';

  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const out = await publish();
      if (out !== 'published') return setState(out);
      toast('Published', { kind: 'success' });
      onClose();
      onPublished?.();
    } catch (err) {
      setError(failure(err, 'The dashboard could not be published.'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = (
    <DialogClose asChild>
      <Button variant="ghost">{state === 'unsaved' ? 'Close' : 'Cancel'}</Button>
    </DialogClose>
  );
  let body;
  let footer;
  if (state === 'changed') {
    body = (
      <p className={s.refusal} role="alert">
        <Icon name="alert" />
        <span>Someone else saved this dashboard after you opened it, so nothing was published: viewers would have seen edits you have not. Reload to see them, then publish.</span>
      </p>
    );
    footer = (
      <>
        {cancel}
        <Button
          variant="primary"
          icon="refresh"
          onClick={() => {
            onClose();
            ed.reload();
          }}
        >
          Reload
        </Button>
      </>
    );
  } else if (state === 'unsaved') {
    body = (
      <p className={s.refusal} role="alert">
        <Icon name="alert" />
        <span>Your latest edits are not saved yet, so nothing was published. Retry the save at the top of the page, then publish.</span>
      </p>
    );
    footer = cancel;
  } else {
    body = (
      <>
        <ul className={s.points}>
          <Point icon="globe" title={`Everyone in ${project ?? 'this project'} can see it`}>
            It goes on the Dashboards page for viewers and editors.
          </Point>
          <Point icon="lock" title="Viewers see this version">
            The layout, filters and charts stay as they are now. Edits you make later stay in your draft until you publish again.
          </Point>
          <Point icon="refresh" title="Figures stay live">
            Numbers update when the data refreshes, the same as today.
          </Point>
        </ul>
        <ul className={s.chips} aria-label="What is published">
          {contentsOf(ed.doc).map((c) => (
            <li key={c} className={s.chip}>
              {c}
            </li>
          ))}
        </ul>
        {error && (
          <p className={s.refusal} role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
      </>
    );
    footer = (
      <>
        {cancel}
        <Button variant="primary" icon="upload" loading={busy} autoFocus onClick={() => void go()}>
          {verb}
        </Button>
      </>
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} size="md" title={`Publish “${ed.doc.name}”?`} footer={footer}>
      {body}
    </Dialog>
  );
}
