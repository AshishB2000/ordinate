// The settings panel's own shapes (hub.css `.stp-*`): a titled group card, a
// row with its title and description on the left and its control on the
// right, and the segmented choice (`.stp-seg`) — a radiogroup, ←/→ moving and
// selecting, one tab stop.

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import s from './Settings.module.css';

export function Group({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className={s.group} aria-labelledby={id}>
      <header className={s.groupHead}>
        <h2 className={s.groupTitle} id={id}>
          {title}
        </h2>
        {desc && <p className={s.groupDesc}>{desc}</p>}
      </header>
      <div className={s.rows}>{children}</div>
    </section>
  );
}

export function Row({ title, desc, children, stack }: { title: string; desc?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={stack ? `${s.row} ${s.stack}` : s.row}>
      <div className={s.rl}>
        <div className={s.rt}>{title}</div>
        {desc && <div className={s.rd}>{desc}</div>}
      </div>
      {children && <div className={s.rr}>{children}</div>}
    </div>
  );
}

export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string; hint?: string }[];
  onChange: (v: V) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const at = options.findIndex((o) => o.value === value);
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (Math.max(0, at) + step + options.length) % options.length;
    onChange(options[next].value);
    (ref.current?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className={s.seg} role="radiogroup" aria-label={label} ref={ref} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === (at < 0 ? 0 : at) ? 0 : -1}
          className={o.value === value ? `${s.segOpt} ${s.segOn}` : s.segOpt}
          title={o.hint}
          disabled={disabled}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
