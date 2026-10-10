// The small caption under (or beside) a figure that says how fresh it is —
// "As of 1:00 AM", "Live · cached 3 min ago" (L0.2). The words come from
// ./asOf.ts; the time from the server's `asOf`. Nothing is shown without one.
//
// The warning tint (stale, or over a day old) also carries an icon and the
// date in words, so it is never colour alone (as ./Badge does).

import { asOfView, type AsOf } from './asOfView';
import { Icon } from './icons/Icon';
import s from './AsOf.module.css';

export function AsOfCaption({ asOf, className }: { asOf: AsOf | null | undefined; className?: string }) {
  const v = asOfView(asOf);
  if (!v || !asOf) return null;
  return (
    <time className={[s.asOf, v.tone === 'warn' && s.warn, className].filter(Boolean).join(' ')} dateTime={asOf.at} title={v.title} data-testid="as-of">
      {v.tone === 'warn' && <Icon name="alert" size={12} />}
      {v.text}
    </time>
  );
}
