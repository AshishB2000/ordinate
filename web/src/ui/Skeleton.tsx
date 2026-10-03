// Skeletons — hub.css "LOADING SKELETONS" / skeleton.ts. A skeleton says "a
// list of about this shape is arriving" and holds the layout so nothing jumps
// when it lands (plan §7: skeleton, not spinner). The shimmer is a plain CSS
// animation, so base.css's reduced-motion rule stops it.
//
// Each shape is ONE status region (role=status, aria-busy, a label) — the
// bars inside are aria-hidden, so a screen reader hears "Loading datasets"
// once, not twenty grey boxes.

import type { ReactNode } from 'react';
import s from './Skeleton.module.css';

/** One bar, for a bespoke shape. Size it with a class from the caller's CSS. */
export function Skeleton({ className }: { className?: string }) {
  return <span className={className ? `${s.sk} ${className}` : s.sk} aria-hidden="true" />;
}

function Busy({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  return (
    <div className={className} role="status" aria-busy="true" aria-label={label}>
      {children}
    </div>
  );
}

/** A list arriving: icon, name, meta per row; the tail fades. */
export function SkeletonRows({ rows = 5, label }: { rows?: number; label: string }) {
  return (
    <Busy label={label} className={s.list}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.row} aria-hidden="true">
          <span className={`${s.sk} ${s.icon}`} />
          <span className={`${s.sk} ${s.text}`} />
          <span className={`${s.sk} ${s.meta}`} />
        </div>
      ))}
    </Busy>
  );
}

/** A grid arriving: a header strip, then rows of equal cells (the real widths are unknown). */
export function SkeletonTable({ rows = 8, cols = 5, label }: { rows?: number; cols?: number; label: string }) {
  const tr = (key: string, head = false) => (
    <div key={key} className={head ? `${s.tr} ${s.head}` : s.tr} aria-hidden="true">
      {Array.from({ length: cols }, (_, c) => (
        <span key={c} className={`${s.sk} ${s.cell}`} />
      ))}
    </div>
  );
  return (
    <Busy label={label} className={s.table}>
      {tr('h', true)}
      {Array.from({ length: rows }, (_, r) => tr(String(r)))}
    </Busy>
  );
}

/** A chart or a card body arriving: one block filling its host. */
export function SkeletonBlock({ label }: { label: string }) {
  return (
    <Busy label={label} className={s.blockWrap}>
      <span className={`${s.sk} ${s.block}`} aria-hidden="true" />
    </Busy>
  );
}

/** A whole page arriving (a lazy route chunk): the title, then a stack of rows. */
export function PageSkeleton() {
  return (
    <Busy label="Loading page" className={s.page}>
      <span className={`${s.sk} ${s.title}`} aria-hidden="true" />
      <div className={s.list} aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`${s.sk} ${s.bar}`} />
        ))}
      </div>
    </Busy>
  );
}
