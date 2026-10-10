// The one "AI isn't set up" message (docs/ai-models/00-plan.md §5), on every
// surface that needs a model: the dock, Home, Analyses, Visuals, captures.
// A member reads the sentence; an org admin also gets the way to fix it —
// "Set up AI" to Admin → AI, or, when this server cannot store a key at all,
// what the operator has to set.

import { Link } from 'react-router';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { useMe } from '../auth/api';
import type { AiStatus } from './api';
import s from './AiNotReady.module.css';

/** The sentence alone — for a tooltip or a disabled control's title. */
export const AI_NOT_READY = 'AI isn’t set up for your organization yet. An admin can turn it on in Admin → AI.';

export function AiNotReady({ status, className }: { status: Pick<AiStatus, 'keyStore'> | undefined; className?: string }) {
  const me = useMe();
  const admin = me.data?.user?.role === 'admin';
  return (
    <div className={[s.box, className].filter(Boolean).join(' ')} role="note" data-testid="ai-not-ready">
      <p className={s.line}>{AI_NOT_READY}</p>
      {admin &&
        (status?.keyStore ? (
          <p className={s.operator}>{`${status.keyStore} An operator sets DATABASE_URL and ORDINATE_MASTER_KEY to turn AI on.`}</p>
        ) : (
          <Link className={buttonClass('secondary', 'sm')} to="/admin?tab=ai">
            Set up AI <Icon name="arrow-right" size={12} />
          </Link>
        ))}
    </div>
  );
}
