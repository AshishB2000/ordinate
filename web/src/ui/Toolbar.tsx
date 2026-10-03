// Toolbar — a row of controls over a list, a grid or a canvas, as one
// `role="toolbar"`: ←/→ (Home/End) move focus between its controls. Arrow
// keys are left alone inside a text field or a select, which need them.
//
// ponytail: every control stays a Tab stop (no roving tabindex); switch to
// roving if a toolbar ever grows long enough that tabbing through it hurts.

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import s from './Toolbar.module.css';

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const OWNS_ARROWS = 'input, textarea, [role="combobox"], [role="separator"]';

export function Toolbar({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const root = ref.current;
    const at = e.target as HTMLElement;
    if (!root || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || at.matches(OWNS_ARROWS)) return;
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !(el as HTMLButtonElement).disabled && el.closest('[role="toolbar"]') === root,
    );
    const i = items.indexOf(at);
    if (i < 0) return;
    e.preventDefault();
    const n = items.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
    items[next].focus();
  }

  return (
    <div ref={ref} role="toolbar" aria-label={label} className={className ? `${s.bar} ${className}` : s.bar} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

/** A hairline between groups of controls. */
export function ToolbarDivider() {
  return <span className={s.divider} aria-hidden="true" />;
}

/** Pushes what follows to the far end of the bar. */
export function ToolbarSpacer() {
  return <span className={s.spacer} aria-hidden="true" />;
}
