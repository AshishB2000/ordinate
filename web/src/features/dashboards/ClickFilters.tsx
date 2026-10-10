// Click-to-filter's visible state, in the sheet's filter area: one chip per
// click-filter — "State: California ×" — each a button that takes it away,
// then "Clear" (Esc does the same). These are the READER's own clicks: view
// state, never saved, drawn apart from the author's controls above them (a
// tinted pill behind the click mark, not a labelled widget).
//
// The row is there whenever a chart on the sheet can be clicked, saying so
// while nothing is — so the sheet does not jump under the pointer when the
// first chip arrives, and the second click lands on the mark it was aimed at.
// A sheet with no clickable chart has no row.

import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { Icon } from '../../ui/icons/Icon';
import type { EditorApi } from '../analyses/editor/context';
import type { ClickFilter } from '../analyses/editor/filters';
import { IS_MAC } from '../palette/registry';
import { clickColumns } from './CardRuntime';
import s from './ClickFilters.module.css';

/** How many values a chip spells out before "+N". */
const SPELLED = 3;
/** The multi-select key as this reader's keyboard names it (either works). */
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const word = (v: string) => (v === '' ? '(blank)' : v);

/** "California, Texas, Ohio +2" — the chip's values; `all` spells every one (the tooltip, the accessible name). */
export function clickValues(c: ClickFilter, all = false): string {
  const shown = all ? c.values : c.values.slice(0, SPELLED);
  const more = c.values.length - shown.length;
  return shown.map(word).join(', ') + (more > 0 ? ` +${more}` : '');
}

export function ClickFilterBar({ ed }: { ed: EditorApi }) {
  const clicks = ed.view.clicks;
  const visualOf = (cardId: string) => {
    const card = ed.cards.find((x) => x.id === cardId);
    return card?.type === 'visual' && card.visualId ? ed.visuals.get(card.visualId) : undefined;
  };
  if (!clicks.length) {
    const clickable = ed.cards.some((c) => {
      const def = visualOf(c.id);
      return !!def && clickColumns(ed, def) !== null;
    });
    if (!clickable) return null;
    return (
      <div className={`${s.bar} ${s.idle}`} role="group" aria-label="Click filters">
        <span className={s.label}>
          <Icon name="target" size={12} />
          Click to filter
        </span>
        <span className={s.note}>Click a mark on a chart to filter the other cards.</span>
        <span className={s.hint}>
          <Kbd>{MOD}</Kbd>-click picks several
        </span>
      </div>
    );
  }
  const from = (c: ClickFilter): string => {
    const name = visualOf(c.origin)?.name;
    return name ? ` — clicked on “${name}”` : '';
  };
  return (
    <div className={s.bar} role="group" aria-label="Click filters">
      <span className={s.label}>
        <Icon name="target" size={12} />
        Clicked
      </span>
      <ul className={s.chips}>
        {clicks.map((c) => {
          const text = `${c.column}: ${clickValues(c, true)}`;
          return (
            <li key={`${c.origin}\u0000${c.column}`}>
              <button type="button" className={s.chip} aria-label={`Remove click filter ${text}`} title={`${text}${from(c)}. Click to remove.`} onClick={() => ed.view.clearClicks(c)}>
                <span className={s.col}>{c.column}:</span>
                <span className={s.vals}>{clickValues(c)}</span>
                <Icon name="x" size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      <Button size="sm" variant="ghost" onClick={() => ed.view.clearClicks()}>
        Clear
      </Button>
      <span className={s.hint}>
        <Kbd>Esc</Kbd> clears · <Kbd>{MOD}</Kbd>-click adds
      </span>
    </div>
  );
}
