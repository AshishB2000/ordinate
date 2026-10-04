// The arrange bar (legacy gridArrange.ts renderArrangeBar): with two or more
// cards ⇧-selected, align them to one edge or centre, spread three or more
// with equal gaps, or put them in a container or a tabs card. Every change is
// one undo step; the geometry is geometry.ts.

import { Button } from '../../../ui/Button';
import type { Layout } from '../api';
import { Toolbar } from '../../../ui/Toolbar';
import { addGroup } from './arrange';
import { useEditor } from './context';
import { uuid } from './doc';
import { alignLayouts, distributeLayouts, fitGroup, type AlignMode } from './geometry';
import s from './Canvas.module.css';

const ALIGN: [AlignMode, string, string][] = [
  ['left', 'Left', 'Align left edges'],
  ['center', 'Centre', 'Align centres'],
  ['right', 'Right', 'Align right edges'],
  ['top', 'Top', 'Align top edges'],
  ['middle', 'Middle', 'Align middles'],
  ['bottom', 'Bottom', 'Align bottom edges'],
];

export function ArrangeBar() {
  const ed = useEditor();
  const ids = [...ed.multi].filter((id) => ed.cards.some((c) => c.id === id && c.type !== 'control'));
  if (ids.length < 2 || ed.size !== 'desktop') return null;
  const arrange = (label: string, fn: (ls: Layout[]) => void) =>
    ed.edit(label, (d) => {
      const cards = d.sheets[ed.sheet].cards;
      const picked = cards.filter((c) => ids.includes(c.id));
      fn(picked.map((c) => c.layout));
      // Children pulled along: their groups refit around them.
      for (const c of picked) if (c.parentId) fitGroup(cards, c.parentId);
    });
  const group = (kind: 'container' | 'tabs') => {
    const id = uuid();
    ed.edit(`Add ${kind}`, (d) => addGroup(d.sheets[ed.sheet].cards, kind, ids, id));
    ed.setMulti(new Set());
    ed.select(id);
  };
  return (
    <div className={s.arrange}>
      <Toolbar label="Arrange selected cards">
        <span className={s.arrangeCount}>{ids.length} cards selected</span>
        <span className={s.arrangeGroup} role="group" aria-label="Align">
          <span className={s.arrangeLabel}>Align</span>
          {ALIGN.map(([mode, text, title]) => (
            <Button key={mode} size="sm" title={title} onClick={() => arrange('Align cards', (ls) => alignLayouts(ls, mode))}>
              {text}
            </Button>
          ))}
        </span>
        <span className={s.arrangeGroup} role="group" aria-label="Distribute">
          <span className={s.arrangeLabel}>Distribute</span>
          <Button size="sm" title="Equal gaps left to right" disabled={ids.length < 3} onClick={() => arrange('Distribute cards', (ls) => distributeLayouts(ls, 'x'))}>
            Across
          </Button>
          <Button size="sm" title="Equal gaps top to bottom" disabled={ids.length < 3} onClick={() => arrange('Distribute cards', (ls) => distributeLayouts(ls, 'y'))}>
            Down
          </Button>
        </span>
        <span className={s.arrangeGroup} role="group" aria-label="Group">
          <span className={s.arrangeLabel}>Group</span>
          <Button size="sm" title="Put the selected cards in a container" onClick={() => group('container')}>
            Container
          </Button>
          <Button size="sm" title="Put the selected cards in the first tab of a new tabs card" onClick={() => group('tabs')}>
            Tabs
          </Button>
        </span>
        <Button size="sm" variant="ghost" onClick={() => ed.setMulti(new Set())}>
          Done
        </Button>
      </Toolbar>
    </div>
  );
}
