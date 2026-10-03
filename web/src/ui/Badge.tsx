// Badge — a short status word on a row or a card ("Archived", "Draft",
// "Failed"). hub.css `.ws-badge`: 11px uppercase on a pill. Tone is colour
// AND the word, never colour alone.

import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons/Icon';
import s from './Badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'error';

export function Badge({ tone = 'neutral', icon, children }: { tone?: BadgeTone; icon?: IconName; children: ReactNode }) {
  return (
    <span className={`${s.badge} ${s[tone]}`}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

