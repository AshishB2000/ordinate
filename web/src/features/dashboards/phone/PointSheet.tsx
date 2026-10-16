// What a tap on a chart point offers on a phone (docs/phone-dashboards), in
// a bottom sheet instead of a context menu nobody can right-click: the same
// actions the desktop's click and right-click run — filter the dashboard to
// it, the rows behind it, explain the change, a comment on it. Each row is a
// full-width 52px target; choosing one closes the sheet first.

import { Sheet } from '../../../ui/Sheet';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import s from './Phone.module.css';

export interface PointAction {
  label: string;
  hint?: string;
  icon: IconName;
  run: () => void;
}

export function PointSheet({ title, chart, actions, onClose }: { title: string; chart: string; actions: PointAction[]; onClose: () => void }) {
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={title} description={chart}>
      <ul className={s.actions} aria-label={`What to do with ${title}`}>
        {actions.map((a) => (
          <li key={a.label}>
            <button
              type="button"
              className={s.action}
              onClick={() => {
                onClose();
                a.run();
              }}
            >
              <span className={s.actionIcon} aria-hidden="true">
                <Icon name={a.icon} size={16} />
              </span>
              <span className={s.actionText}>
                <span className={s.actionLabel}>{a.label}</span>
                {a.hint && <span className={s.actionHint}>{a.hint}</span>}
              </span>
              <span className={s.actionGo} aria-hidden="true">
                <Icon name="chevron-right" size={16} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
