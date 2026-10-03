// Gallery scaffolding: a titled section and a labelled cell per state.

import type { ReactNode } from 'react';
import g from './Gallery.module.css';

export function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section className={g.section} aria-labelledby={`g-${id}`}>
      <header className={g.sectionHead}>
        <h2 id={`g-${id}`} className={g.sectionTitle}>
          {title}
        </h2>
        {note && <p className={g.note}>{note}</p>}
      </header>
      {children}
    </section>
  );
}

/** One state of one component, captioned with the state's name. */
export function Cell({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? `${g.cell} ${g.wide}` : g.cell}>
      <span className={g.caption}>{label}</span>
      <div className={g.sample}>{children}</div>
    </div>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className={g.grid}>{children}</div>;
}
