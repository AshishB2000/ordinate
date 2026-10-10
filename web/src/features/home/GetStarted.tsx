// First-run guidance — getStarted.ts, ported: four things to do, each with
// its door. What is DONE comes from the server (src/app/onboarding.ts reads it
// off the org's records), so the card never claims a step nobody took. It
// folds into a "2 of 4" pill beside New, and goes for good when every step is
// done or someone hides it. The card is the ORG's: folding and hiding it is an
// editor's call (`onboarding:set` is write), so a viewer sees it without those.

import { Link } from 'react-router';
import { useOnboarding, useSetOnboarding, type StepId } from '../../api/home';
import { useMe } from '../auth/api';
import { buttonClass, IconButton } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { toast } from '../../ui/Toast';
import s from './GetStarted.module.css';

interface Step {
  id: StepId;
  icon: IconName;
  title: string;
  line: string;
  action: string;
  to: string;
}

// The doors land on each area's page; the flows they open (import, the visual
// builder, the template wizard, the model settings) arrive with T2.4, T2.7,
// T2.8 and T2.12.
const STEPS: Step[] = [
  {
    id: 'import', icon: 'upload', title: 'Import your data', to: '/data', action: 'Import',
    line: 'Bring in a CSV or Excel file, paste a table, or connect a database.',
  },
  {
    id: 'visual', icon: 'chart-bar', title: 'Build a visual', to: '/visuals', action: 'Open the builder',
    line: 'Chart the sample orders by month, region or category in a few clicks.',
  },
  {
    id: 'dashboard', icon: 'layout-dashboard', title: 'Create a dashboard', to: '/dashboards', action: 'Browse templates',
    line: 'Start from a template and have a laid-out sheet in one step.',
  },
  {
    id: 'assistant', icon: 'sparkles', title: 'Set up the Assistant', to: '/admin?tab=ai', action: 'Set up',
    line: 'An admin connects a provider and picks the models everyone may use. Everything else works without one.',
  },
];

function useCanEdit(): boolean {
  const role = useMe().data?.user?.role;
  return role === 'admin' || role === 'editor';
}

/** The folded card: "Get started | 2 of 4", beside New. */
export function GetStartedPill() {
  const q = useOnboarding();
  const set = useSetOnboarding();
  const d = q.data;
  if (!d?.show || !d.collapsed) return null;
  const progress = `${d.doneCount} of ${d.total}`;
  return (
    <button
      type="button"
      className={s.pill}
      aria-label={`Get started: ${progress} done — show the checklist`}
      onClick={() => set.mutate({ collapsed: false })}
    >
      <Icon name="circle-check" size={12} />
      <span>Get started</span>
      <span className={s.pillCount}>{progress}</span>
    </button>
  );
}

export function GetStarted() {
  const q = useOnboarding();
  const set = useSetOnboarding();
  const canEdit = useCanEdit();
  const d = q.data;
  // Loading or failed: nothing — the card is guidance, not content, and Home
  // reads fine without it (the desktop hides it the same way).
  if (!d?.show || d.collapsed) return null;
  const done = new Set(d.steps.filter((x) => x.done).map((x) => x.id));
  const progress = `${d.doneCount} of ${d.total}`;
  const change = (patch: { collapsed?: boolean; dismissed?: true }, after?: () => void) =>
    set.mutate(patch, {
      onSuccess: after,
      onError: () => toast('That could not be saved. Try again.', { kind: 'error' }),
    });
  return (
    <section className={s.card} aria-labelledby="gs-title">
      <div className={s.head}>
        <span className={s.mark} aria-hidden="true">
          <Icon name="sparkles" size={20} />
        </span>
        <div className={s.headText}>
          <h2 id="gs-title" className={s.title}>
            Get started
          </h2>
          <p className={s.sub}>Four things to try — with the sample data, or with your own.</p>
        </div>
        <div className={s.meter}>
          <span className={s.count}>{progress}</span>
          <progress className={s.bar} value={d.doneCount} max={d.total || 1} aria-label={`Get started: ${progress} done`} />
        </div>
        {canEdit && (
          <>
            <IconButton icon="chevron-up" size="sm" label="Fold the checklist into a progress pill" onClick={() => change({ collapsed: true })} />
            <IconButton
              icon="x"
              size="sm"
              label="Hide Get started"
              onClick={() => change({ dismissed: true }, () => toast('Get started is hidden. Everything it pointed to is in the sidebar.'))}
            />
          </>
        )}
      </div>
      <ol className={s.items}>
        {STEPS.map((st) => {
          const ok = done.has(st.id);
          return (
            <li key={st.id} className={ok ? `${s.item} ${s.done}` : s.item} data-step={st.id}>
              <div className={s.itemTop}>
                <span className={s.tile} aria-hidden="true">
                  <Icon name={st.icon} />
                </span>
                <span className={s.tick} role="img" aria-label={ok ? 'Done' : 'Not done yet'}>
                  <Icon name={ok ? 'circle-check' : 'circle'} size={20} />
                </span>
              </div>
              <div className={s.itemBody}>
                <h3 className={s.itemTitle}>{st.title}</h3>
                <p className={s.itemLine}>{st.line}</p>
              </div>
              {ok ? (
                <span className={s.doneLabel}>
                  <Icon name="check" size={12} />
                  Done
                </span>
              ) : (
                <Link className={buttonClass('ghost', 'sm', s.action)} to={st.to}>
                  {st.action}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
