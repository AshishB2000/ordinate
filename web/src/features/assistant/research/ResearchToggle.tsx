// The composer's Deep research switch: one pressed-state button and, when on, one line of help. Disabled with its reason when a
// run is already going. Not drawn at all for a viewer (they cannot start one) or when AI is not ready (the composer already says why).

import { Icon } from '../../../ui/icons/Icon';
import type { Research } from './useResearch';
import s from './Research.module.css';

export const helpText = (minutes: number): string => `Runs several steps and writes a report. Up to ${minutes} minute${minutes === 1 ? '' : 's'}.`;

export function ResearchToggle({ r }: { r: Research }) {
  if (!r.allowed) return null;
  return (
    <button
      type="button"
      className={s.toggle}
      aria-pressed={r.on}
      disabled={!!r.reason}
      title={r.reason ?? helpText(r.minutes)}
      aria-describedby={r.on ? 'research-help' : undefined}
      data-testid="research-toggle"
      onClick={() => r.setOn(!r.on)}
    >
      <Icon name="sparkles" size={12} />
      Deep research
    </button>
  );
}

/** The line under the question while the switch is on, or the reason it cannot be. */
export function ResearchHelp({ r }: { r: Research }) {
  if (!r.allowed) return null;
  const text = r.on ? helpText(r.minutes) : r.reason;
  return text ? <p id="research-help" className={s.toggleHelp} role="status">{text}</p> : null;
}
