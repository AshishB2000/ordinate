// An event kind's mark — the SAME glyph a chart draws on its date axis
// (chartEvents.evIcon / eventsPage.evKindMark): a disc in the kind's colour
// with a white glyph.

import s from './Events.module.css';

const GLYPH: Record<string, string> = {
  launch: 'M8 4 11.5 11h-7Z',
  campaign: 'M8 4 12 8 8 12 4 8Z',
  incident: 'M7.1 4h1.8l-.3 5.4H7.4ZM8 10.4a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
  holiday: 'M8 3.6 9.1 6.6 12.2 6.6 9.7 8.5 10.6 11.6 8 9.8 5.4 11.6 6.3 8.5 3.8 6.6 6.9 6.6Z',
  other: 'M8 5.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z',
};

export function KindMark({ kind }: { kind: string }) {
  const k = kind in GLYPH ? kind : 'other';
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={`${s.mark} ${s[`k_${k}`]}`}>
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      <path d={GLYPH[k]} fill="#fff" />
    </svg>
  );
}
