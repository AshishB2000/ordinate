// The drill path above a drilled chart: `Geography › East · by state`, each level above the current one a button back
// to it, the current one plain text, and "Up" for one step. The caller owns what a step does (Explore pushes a URL,
// a tile steps its own state); this only draws.

import { Fragment } from 'react';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import s from './DrillCrumbs.module.css';

export function DrillCrumbs({ crumbs, by, onUp }: { crumbs: { label: string; go?: () => void }[]; by: string; onUp: () => void }) {
  return (
    <nav className={s.path} aria-label="Drill path">
      <ol className={s.crumbs}>
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <li className={s.sep} aria-hidden="true">
                <Icon name="chevron-right" size={12} />
              </li>
            )}
            <li className={s.crumb}>
              {c.go ? (
                <button type="button" className={s.go} onClick={c.go}>
                  {c.label}
                </button>
              ) : (
                <span className={s.here} aria-current="location">
                  {c.label}
                </span>
              )}
            </li>
          </Fragment>
        ))}
        <li className={s.by}>· by {by}</li>
      </ol>
      <Button size="sm" variant="ghost" icon="arrow-up" onClick={onUp}>
        Up
      </Button>
    </nav>
  );
}
