// The block picker (storyPickers.ts stOpenPicker). Typed as `/` into an empty
// line it filters by what follows the slash and takes ↑ ↓ Enter from that
// field, so typing never leaves the line; from a block's "+" it is an ordinary
// menu (the shared kit's, keyboard and focus included).

import { useEffect, useState } from 'react';
import type { MenuEntry } from '../../../ui/Menu';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import pk from './Pickers.module.css';

export type PickKind = 'text' | 'heading' | 'visual' | 'metric' | 'metrics_row' | 'image' | 'divider' | 'callout';

export const PICKS: Array<{ kind: PickKind; label: string; icon: IconName; hint: string }> = [
  { kind: 'text', label: 'Text', icon: 'type-text', hint: 'A paragraph — Markdown works' },
  { kind: 'heading', label: 'Heading', icon: 'list', hint: 'A section — it opens a page when presenting' },
  { kind: 'visual', label: 'Chart', icon: 'chart-bar', hint: 'A saved chart, live' },
  { kind: 'metric', label: 'Metric', icon: 'zap', hint: 'One named number, live' },
  { kind: 'metrics_row', label: 'Metrics row', icon: 'columns', hint: 'Up to four metrics side by side' },
  { kind: 'image', label: 'Image', icon: 'camera', hint: 'A picture from your computer' },
  { kind: 'divider', label: 'Divider', icon: 'minus', hint: 'A rule across the page' },
  { kind: 'callout', label: 'Callout', icon: 'info', hint: 'A highlighted note' },
];

export function filterPicks(query: string): typeof PICKS {
  const q = query.replace(/^\//, '').toLowerCase();
  return PICKS.filter((p) => !q || p.label.toLowerCase().includes(q) || p.kind.includes(q));
}

/** The "+" menu's entries. */
export function pickMenu(onPick: (k: PickKind) => void): MenuEntry[] {
  return [{ kind: 'heading', label: 'Add a block' }, ...PICKS.map((p) => ({ label: p.label, icon: p.icon, onSelect: () => onPick(p.kind) }))];
}

/**
 * The slash list under a text field. The field keeps focus; `keys` is wired to
 * its onKeyDown and returns true when it handled the key.
 */
export function useSlashPicker(query: string | null, onPick: (k: PickKind) => void) {
  const items = query === null ? [] : filterPicks(query);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);
  const keys = (e: React.KeyboardEvent): boolean => {
    if (query === null) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
      return true;
    }
    if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      onPick(items[active].kind);
      return true;
    }
    return false;
  };
  const list =
    query === null ? null : (
      <div className={pk.slash} role="listbox" aria-label="Add a block" id="st-slash">
        <div className={pk.slashHead}>Add a block</div>
        {items.length ? (
          items.map((p, i) => (
            <div
              key={p.kind}
              id={`st-slash-${p.kind}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? `${pk.slashRow} ${pk.slashActive}` : pk.slashRow}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(p.kind)}
              onPointerMove={() => setActive(i)}
            >
              <Icon name={p.icon} />
              <span className={pk.slashText}>
                <span className={pk.slashLabel}>{p.label}</span>
                <span className={pk.slashHint}>{p.hint}</span>
              </span>
            </div>
          ))
        ) : (
          <div className={pk.slashNone}>No block by that name</div>
        )}
      </div>
    );
  return { list, keys, activeId: items[active] ? `st-slash-${items[active].kind}` : undefined };
}
