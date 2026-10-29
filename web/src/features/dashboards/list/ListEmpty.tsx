// The Dashboards page with nothing to list: an editor's first dashboard (Create, Draft with AI, a screenshot rebuilt,
// or a dataset to start from), a viewer's "nothing published yet", and the empty Published or Drafts tab. Each is a
// full-width panel with a dashboard in miniature, in both themes.

import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { DatasetSummary } from '../../../api/datasets';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import type { AiStatus } from '../../assistant/api';
import { AiNotReady } from '../../assistant/AiNotReady';
import s from './List.module.css';

/** How many datasets the first-run panel offers to start from (anList.ts AN_CHIP_MAX). */
const CHIP_MAX = 3;

function Panel({ small, title, children }: { small?: boolean; title: string; children: ReactNode }) {
  return (
    <section className={small ? `${s.empty} ${s.emptyTab}` : s.empty} aria-label={title}>
      <span className={small ? `${s.art} ${s.artSmall}` : s.art} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
      <h2 className={s.title}>{title}</h2>
      {children}
    </section>
  );
}

/** An editor's project with no dashboard at all: every way to start one. */
export function FirstDashboard({ projectId, ai, aiWhy, datasets, onCreate, onDraft }: {
  projectId: string;
  /** The model check, once answered; undefined while it is asked. */
  ai: AiStatus | undefined;
  aiWhy: string;
  datasets: readonly DatasetSummary[];
  onCreate: () => void;
  onDraft: (datasetId?: string) => void;
}) {
  const aiReady = !!ai?.ready;
  const sets = datasets.slice(0, CHIP_MAX);
  const chipsId = useId();
  return (
    <Panel title="Start your first dashboard">
      <p className={s.lead}>Build one yourself or let AI draft one from your data. It stays a draft that only editors and admins see until you publish it.</p>
      <div className={s.actions}>
        <Button variant="primary" size="lg" icon="plus" onClick={onCreate}>
          Create dashboard
        </Button>
        <Button size="lg" icon="sparkles" disabled={!aiReady} title={aiReady ? undefined : aiWhy} onClick={() => onDraft()}>
          Draft with AI
        </Button>
      </div>
      <p className={s.quiet}>
        Have a screenshot of a dashboard from another tool? <Link to={`/analyses/${projectId}/rebuild`}>Rebuild it here</Link>
      </p>
      {ai && !aiReady && <AiNotReady status={ai} className={s.aiHint} />}
      {aiReady && sets.length > 0 && (
        <>
          <p className={s.chipsHead} id={chipsId}>
            Or start from a dataset
          </p>
          <div className={s.chips} role="group" aria-labelledby={chipsId}>
            {sets.map((d) => (
              <button key={d.id} type="button" className={s.chip} onClick={() => onDraft(d.id)}>
                <Icon name="database" size={12} />
                {d.name || 'Untitled dataset'}
              </button>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

/** A viewer's project with nothing published: what will appear here, and who to ask. */
export function NothingPublished() {
  return (
    <Panel title="Nothing published yet">
      <p className={s.lead}>When an editor publishes a dashboard in this project, it shows up here. Ask a project admin if you expected to see one.</p>
    </Panel>
  );
}

/** One of an editor's two tabs with nothing in it (the other has some). */
export function EmptyTab({ which }: { which: 'published' | 'drafts' }) {
  return which === 'published' ? (
    <Panel small title="Nothing published yet">
      <p className={s.lead}>Viewers see only published dashboards. Open a draft, preview it, and publish it to put it here.</p>
    </Panel>
  ) : (
    <Panel small title="No drafts">
      <p className={s.lead}>A dashboard you create or draft with AI starts here, seen only by editors and admins until you publish it.</p>
    </Panel>
  );
}
