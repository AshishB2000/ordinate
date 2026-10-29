// The editor header's part in Drafts and Publish (docs/superpowers/specs/2026-10-29-dashboard-drafts-publish-design.md):
// where the draft stands — Draft, Published, or Edits not live · published <date> — and what to do about it: Preview
// and Publish; Discard edits and Publish changes once it differs from what viewers see; View published version and
// Unpublish in ⋯ once there is a published version. An editor's only: a viewer's editor is read-only on the copy.

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Badge } from '../../../ui/Badge';
import { Button, IconButton } from '../../../ui/Button';
import { ConfirmDelete } from '../../../ui/ConfirmDelete';
import type { MenuEntry } from '../../../ui/Menu';
import { toast } from '../../../ui/Toast';
import { PublishDraftDialog } from '../../dashboards/drafts/PublishDraft';
import { publishedDay, useOpened } from '../../dashboards/drafts/state';
import { failure, useDraftActions } from '../api';
import { useEditor } from './context';
import s from './Editor.module.css';

export interface DraftControls {
  status: ReactNode;
  buttons: ReactNode;
  /** ⋯ menu entries: before History, and at the end. */
  menuTop: MenuEntry[];
  menuEnd: MenuEntry[];
  dialogs: ReactNode;
}

export function useDraftControls(): DraftControls {
  const ed = useEditor();
  const navigate = useNavigate();
  const opened = useOpened(ed);
  const acts = useDraftActions(ed.projectId, ed.analysisId);
  const [asking, setAsking] = useState<'publish' | 'discard' | 'unpublish' | null>(null);
  const status = opened?.status ?? 'draft';
  const when = publishedDay(opened?.published?.publishedAt);
  const view = `/dashboards/${ed.projectId}/${ed.analysisId}`;
  // Someone else saved first (editConflicts): Reload in the banner is the way on; publishing now would refuse.
  const stuck = ed.save.changed ? 'Someone else saved this dashboard. Reload it first.' : undefined;

  const preview = async () => {
    await ed.save.flush(); // the Preview reads what is saved
    void navigate(`${view}?draft=1`);
  };
  const discard = async () => {
    try {
      await ed.save.flush();
      // Through the save queue: the restored draft's tag becomes this editor's base, so its own push is not news.
      // The page then opens the restored draft in a new editor (AuthoringPage keys it by the reply's tag).
      if (await ed.save.send(() => acts.discard.mutateAsync())) toast('Edits discarded: the draft is the published version again.', { kind: 'success' });
    } catch (err) {
      toast(failure(err, 'The edits could not be discarded.'), { kind: 'error' });
    } finally {
      setAsking(null);
    }
  };
  const unpublish = async () => {
    try {
      await acts.unpublish.mutateAsync();
      toast('Unpublished: viewers no longer see it. Your draft stays.', { kind: 'success' });
    } catch (err) {
      toast(failure(err, 'The dashboard could not be unpublished.'), { kind: 'error' });
    } finally {
      setAsking(null);
    }
  };

  if (ed.readOnly) return { status: null, buttons: null, menuTop: [], menuEnd: [], dialogs: null };
  const live = status !== 'draft';
  return {
    status:
      status === 'draft' ? (
        <span title="Only editors and admins see a draft. Viewers see it once you publish it.">
          <Badge>Draft</Badge>
        </span>
      ) : status === 'published' ? (
        <span title={`Viewers see this version, published ${when}.`}>
          <Badge tone="ok" icon="circle-check">
            Published
          </Badge>
        </span>
      ) : (
        <span className={s.notLive} title={`Viewers still see the version published ${when}.`}>
          <Badge tone="warn">Edits not live</Badge>
          <span className={s.publishedOn}>published {when}</span>
        </span>
      ),
    buttons: (
      <>
        <span className={s.headRule} aria-hidden="true" />
        {/* An icon, named and titled, so the title row holds at 1280 px; the dialog it opens says what goes back. */}
        {status === 'edited' && (
          <IconButton
            icon="rotate-ccw"
            size="sm"
            label="Discard edits"
            disabled={!!stuck}
            title={stuck ?? `Discard edits: back to the version published ${when}`}
            onClick={() => setAsking('discard')}
          />
        )}
        <Button size="sm" icon="eye" onClick={() => void preview()}>
          Preview
        </Button>
        {/* In step with what viewers see, Publish is quiet — it would only refreeze the charts. */}
        <Button size="sm" variant={status === 'published' ? 'secondary' : 'primary'} icon="upload" disabled={!!stuck} title={stuck} onClick={() => setAsking('publish')}>
          {status === 'edited' ? 'Publish changes' : 'Publish'}
        </Button>
      </>
    ),
    menuTop: live ? [{ label: 'View published version', icon: 'eye', onSelect: () => void navigate(view) }] : [],
    menuEnd: live ? [{ kind: 'separator' }, { label: 'Unpublish…', icon: 'eye-off', onSelect: () => setAsking('unpublish') }] : [],
    dialogs: (
      <>
        {asking === 'publish' && <PublishDraftDialog onClose={() => setAsking(null)} />}
        {asking === 'discard' && (
          <ConfirmDelete
            title="Discard your edits?"
            description={`The draft goes back to the version published ${when}: its layout, filters, text and KPI cards. Charts show as they are now in Visuals, so a chart changed there keeps its changes. Your edits stay in History.`}
            confirm="Discard edits"
            busy={acts.discard.isPending}
            onConfirm={() => void discard()}
            onClose={() => setAsking(null)}
          />
        )}
        {asking === 'unpublish' && (
          <ConfirmDelete
            title={`Unpublish “${ed.doc.name}”?`}
            description="It comes off the Dashboards page and viewers can no longer open it. Your draft stays, and you can publish it again."
            confirm="Unpublish"
            busy={acts.unpublish.isPending}
            onConfirm={() => void unpublish()}
            onClose={() => setAsking(null)}
          />
        )}
      </>
    ),
  };
}
