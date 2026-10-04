// Layouts for every size, around the grid (legacy layoutSizes.ts lyPaintNote /
// lyPaintTray / lyPaintHead): the switcher in the head, the note above a small
// size's grid (which size, why, derived or edited, Reset), and the tray of
// cards hidden on it.

import { Button } from '../../../ui/Button';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import { useEditor } from './context';
import { cardTitle } from './CardView';
import { BREAKPOINTS, FRAME_WIDTH, SIZE_LABEL, SIZES, type Size } from './geometry';
import s from './Canvas.module.css';

const ICON: Record<Size, IconName> = { desktop: 'monitor', tablet: 'tablet', phone: 'smartphone' };
const WHAT: Record<Size, string> = { desktop: 'the 12-column grid', tablet: '8 columns', phone: 'one column, KPIs two-up' };

const edited = (layouts: { tablet?: { items: unknown[] }; phone?: { items: unknown[] } } | undefined, size: Size) =>
  size !== 'desktop' && !!layouts?.[size]?.items.length;

/** Desktop / Tablet / Phone. Clicking the size the pane would pick anyway follows the pane again. */
export function SizeSwitch() {
  const ed = useEditor();
  const layouts = ed.doc.sheets[ed.sheet].layouts;
  return (
    <div className={s.sizes} role="group" aria-label="Layout size">
      {SIZES.map((size) => {
        const on = size === ed.size;
        const ed2 = edited(layouts, size);
        const state = size === 'desktop' ? '' : ed2 ? ', edited' : ', derived';
        return (
          <button
            key={size}
            type="button"
            className={on ? `${s.sizeBtn} ${s.sizeOn}` : s.sizeBtn}
            aria-pressed={on}
            aria-label={`${SIZE_LABEL[size]} layout${state}`}
            title={`${SIZE_LABEL[size]} — ${WHAT[size]}${size === 'desktop' ? '' : ed2 ? ' (edited)' : ' (derived)'}${on && !ed.pinned ? " · picked for this pane's width" : ''}`}
            onClick={() => ed.setPinned(size)}
          >
            <Icon name={ICON[size]} />
            {ed2 && <span className={s.sizeDot} aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

export function SizeNote() {
  const ed = useEditor();
  if (ed.size === 'desktop') return null;
  const page = ed.doc.sheets[ed.sheet];
  const size = ed.size;
  const name = SIZE_LABEL[size].toLowerCase();
  const isEdited = edited(page.layouts, size);
  const framed = !!ed.pinned;
  const reset = () =>
    ed.edit(`Reset ${name} layout`, (d) => {
      const sh = d.sheets[ed.sheet];
      const next = { ...sh.layouts };
      delete next[size];
      if (Object.keys(next).length) sh.layouts = next;
      else delete sh.layouts;
    });
  return (
    <div className={s.note}>
      <Icon name={ICON[size]} />
      <span className={s.noteText} role="status">
        {framed ? (
          <>
            <strong>
              {SIZE_LABEL[size]} preview · {FRAME_WIDTH[size]}px.
            </strong>{' '}
            Drag a card by its header to reorder it and its bottom edge to change its height — or use its ⋯ menu, the arrow keys and shift+arrows — or hide it on {name}. Desktop is unchanged.
          </>
        ) : (
          <>
            <strong>Showing the {name} layout.</strong> This pane is narrower than {size === 'phone' ? BREAKPOINTS.phone : BREAKPOINTS.tablet}px, so edits here
            change the {name} layout only.
          </>
        )}
      </span>
      <span className={isEdited ? `${s.state} ${s.stateEdited}` : s.state} title={isEdited ? `This page has a ${name} layout of its own.` : `Laid out from the desktop grid. Your first change here keeps a ${name} layout of its own.`}>
        {isEdited ? 'Edited' : 'Derived'}
      </span>
      {isEdited && (
        <Button size="sm" icon="rotate-ccw" onClick={reset}>
          Reset to derived
        </Button>
      )}
      {!framed && (
        <Button size="sm" icon="monitor" onClick={() => ed.setPinned('desktop')}>
          Edit desktop layout
        </Button>
      )}
    </div>
  );
}

export function HiddenTray({ hidden, onShow }: { hidden: string[]; onShow: (id: string) => void }) {
  const ed = useEditor();
  if (!hidden.length) return null;
  const name = SIZE_LABEL[ed.size].toLowerCase();
  return (
    <section className={s.tray} aria-label={`Cards hidden on ${name}`}>
      <div className={s.trayHead}>
        <Icon name="eye-off" />
        <span className={s.trayTitle}>Hidden on {name}</span>
        <span className={s.trayCount}>{hidden.length}</span>
        <span className={s.trayHint}>Still on desktop{ed.size === 'phone' ? ' and tablet' : ' and phone'} unless hidden there too.</span>
      </div>
      <div className={s.trayList}>
        {hidden.map((id) => {
          const card = ed.cards.find((c) => c.id === id);
          if (!card) return null;
          const title = cardTitle(card, ed);
          return (
            <div key={id} className={s.trayChip}>
              <Icon name={card.type === 'metric' ? 'target' : card.type === 'visual' ? 'chart-bar' : card.type === 'text' ? 'file-text' : 'grid'} />
              <span className={s.trayName}>{title}</span>
              <Button size="sm" icon="eye" aria-label={`Show ${title} on ${name}`} onClick={() => onShow(id)}>
                Show
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
