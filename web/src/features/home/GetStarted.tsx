// First-run guidance: a quick tour of the app, one stop per area. Each stop
// ticks when this person opens its page, from the card or the sidebar
// (tourVisits.ts, in the shell), or for the Assistant when they ask it
// something. The tour is EACH PERSON'S and the server keeps it
// (src/app/onboarding.ts), including the count, so the card never claims a
// visit that did not happen. Anyone can fold it into the "2 of 5" pill beside
// New or hide it; it goes for good once every stop is ticked.

import { Link } from 'react-router';
import { useOnboarding, useSetOnboarding, type StepId } from '../../api/home';
import { Button, buttonClass, IconButton } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { toast } from '../../ui/Toast';
import { setDockOpen } from '../assistant/dockState';
import s from './GetStarted.module.css';

interface Stop {
  icon: IconName;
  title: string;
  line: string;
  action: string;
  /** The page; the Assistant has none, its action opens the dock. */
  to?: string;
}

const STOPS: Record<StepId, Stop> = {
  assistant: { icon: 'sparkles', title: 'Ask the Assistant', action: 'Ask', line: 'Ask a question, or have it build a chart or a dashboard for you.' },
  explore: { icon: 'trending-up', title: 'Explore', action: 'Open Explore', to: '/explore', line: 'Ask a question of your data and get a chart back. No AI needed.' },
  dashboards: { icon: 'layout-dashboard', title: 'Dashboards', action: 'Open Dashboards', to: '/dashboards', line: 'See your key numbers on one page, or start one from a template.' },
  reports: { icon: 'file-text', title: 'Reports', action: 'Open Reports', to: '/reports', line: 'Send a dashboard as a PDF, PowerPoint or Word file, or on a schedule.' },
  data: { icon: 'database', title: 'Data', action: 'Open Data', to: '/data', line: 'Your datasets. Bring in a file, paste a table, or connect a database.' },
};

/** The folded card: "Get started | 2 of 5", beside New. */
export function GetStartedPill() {
  const q = useOnboarding();
  const set = useSetOnboarding();
  const d = q.data;
  if (!d?.show || !d.collapsed) return null;
  const progress = `${d.doneCount} of ${d.total}`;
  return (
    <button type="button" className={s.pill} aria-label={`Get started: ${progress} done, show the checklist`} onClick={() => set.mutate({ collapsed: false })}>
      <Icon name="circle-check" size={12} />
      <span>Get started</span>
      <span className={s.pillCount}>{progress}</span>
    </button>
  );
}

/** `noData`: the current project has no datasets yet, so Data comes first (every other stop would open onto an empty page). */
export function GetStarted({ noData }: { noData: boolean }) {
  const q = useOnboarding();
  const set = useSetOnboarding();
  const d = q.data;
  // Loading or failed: nothing. The card is guidance, not content, and Home reads fine without it.
  if (!d?.show || d.collapsed) return null;
  const steps = noData ? [...d.steps.filter((x) => x.id === 'data'), ...d.steps.filter((x) => x.id !== 'data')] : d.steps;
  const next = steps.find((x) => !x.done)?.id;
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
          <p className={s.sub}>A quick tour. Open each one and it ticks itself off.</p>
        </div>
        <div className={s.meter}>
          <span className={s.count}>{progress}</span>
          <progress className={s.bar} value={d.doneCount} max={d.total || 1} aria-label={`Get started: ${progress} done`} />
        </div>
        <IconButton icon="chevron-up" size="sm" label="Fold the checklist into a progress pill" onClick={() => change({ collapsed: true })} />
        <IconButton
          icon="x"
          size="sm"
          label="Hide Get started"
          onClick={() => change({ dismissed: true }, () => toast('Get started is hidden. Everything it pointed to is in the sidebar.'))}
        />
      </div>
      <ol className={s.items} data-count={steps.length}>
        {steps.map(({ id, done }) => {
          const st = STOPS[id];
          if (!st) return null;
          const isNext = id === next;
          const cls = [s.item, done ? s.done : isNext ? s.next : ''].filter(Boolean).join(' ');
          const variant = isNext ? 'primary' : 'ghost';
          return (
            <li key={id} className={cls} data-step={id}>
              <div className={s.itemTop}>
                <span className={s.tile} aria-hidden="true">
                  <Icon name={st.icon} />
                </span>
                {isNext ? (
                  <span className={s.nextTag}>Next</span>
                ) : (
                  <span className={s.tick} role="img" aria-label={done ? 'Done' : 'Not done yet'}>
                    <Icon name={done ? 'circle-check' : 'circle'} size={20} />
                  </span>
                )}
              </div>
              <div className={s.itemBody}>
                <h3 className={s.itemTitle}>{st.title}</h3>
                <p className={s.itemLine}>{st.line}</p>
              </div>
              {done ? (
                <span className={s.doneLabel}>
                  <Icon name="check" size={12} />
                  Visited
                </span>
              ) : st.to ? (
                <Link className={buttonClass(variant, 'sm', isNext ? undefined : s.action)} to={st.to}>
                  {st.action}
                  {isNext && <Icon name="arrow-right" size={12} />}
                </Link>
              ) : (
                <Button size="sm" variant={variant} className={isNext ? undefined : s.action} onClick={() => setDockOpen(true)}>
                  {st.action}
                  {isNext && <Icon name="arrow-right" size={12} />}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
