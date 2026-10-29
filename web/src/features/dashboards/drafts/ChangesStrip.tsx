// Under the editor's header while the draft holds edits viewers do not see (status `edited`): "Not live yet: 1 card
// added, 1 card changed since you published on Oct 27. See changes". The summary is the version diff's own sentence
// (src/ipc/versionDiff.ts) from the version Publish recorded to the newest one; See changes opens that compare in
// History. A version pruned since (History keeps 50) — or a copy from before Publish kept its key — has no counts.

import { Link } from 'react-router';
import { Icon } from '../../../ui/icons/Icon';
import { useMe } from '../../auth/api';
import type { PublishedMeta } from '../../analyses/api';
import { useEditor } from '../../analyses/editor/context';
import { useVersionDiff, useVersions } from '../../projects/api';
import { publishedDay, useOpened } from './state';
import s from './Drafts.module.css';

export function ChangesStrip() {
  const ed = useEditor();
  const opened = useOpened(ed);
  if (ed.readOnly || opened?.status !== 'edited') return null;
  return <Changes projectId={ed.projectId} id={ed.analysisId} published={opened.published} />;
}

function Changes({ projectId, id, published }: { projectId: string; id: string; published?: PublishedMeta }) {
  const me = useMe().data?.user?.email;
  // The newest version is the draft as saved: the editor's autosave marks this list stale after each save.
  const newest = useVersions(projectId, 'dashboard', id).data?.[0]?.key;
  const from = published?.versionKey;
  const diff = useVersionDiff(projectId, 'dashboard', id, from, from && newest !== from ? newest : undefined).data;
  const when = publishedDay(published?.publishedAt);
  const by = published?.publishedBy;
  const who = by && by === me ? 'you' : by || 'it was';
  const summary = diff && Object.values(diff.counts).some(Boolean) ? diff.summary.charAt(0).toLowerCase() + diff.summary.slice(1) : '';
  return (
    <div className={s.changes} role="status">
      <Icon name="info" />
      <p className={s.changesText}>
        {summary ? `Not live yet: ${summary} since ${who} published on ${when}.` : `Edits not live: viewers still see the version published on ${when}.`}
      </p>
      {summary && from && <Link to={`/versions/${projectId}/dashboard/${id}?compare=${encodeURIComponent(from)}`}>See changes</Link>}
    </div>
  );
}
