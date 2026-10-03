// Catalog tags (catalogUi.ts): coloured chips, the tag filter bar a list
// mounts over its rows, and the tag editor the Details popover uses. The
// active tag lives in the URL (`?tag=`), so one filter follows you from the
// Datasets tab to the Catalog tab — what a tag is for — and a link keeps it.

import { useId, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Icon } from '../../ui/icons/Icon';
import type { TagChip, TagIndex } from './api';
import s from './Data.module.css';

/** Mirrors catalog.normalizeTag on the server (the authority) — for the chip before the round trip. */
export const normTag = (raw: string): string =>
  raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 32);

const colorClass = (c: number) => s[`tag${((c % 8) + 8) % 8}`];

export function Chip({ tag }: { tag: TagChip }) {
  return (
    <span className={`${s.chip} ${colorClass(tag.color)}`} title={`#${tag.name}`}>
      {tag.name}
    </span>
  );
}

/** At most `max` chips, then "+n" naming the rest on hover. */
export function TagChips({ tags, max = 3 }: { tags: readonly TagChip[]; max?: number }) {
  if (!tags.length) return null;
  const rest = tags.slice(max);
  return (
    <span className={s.chips}>
      {tags.slice(0, max).map((t) => (
        <Chip key={t.name} tag={t} />
      ))}
      {rest.length > 0 && (
        <span className={`${s.chip} ${s.chipMore}`} title={rest.map((t) => `#${t.name}`).join(' ')}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/** A record's tags, coloured from the project's index. */
export const tagsOf = (index: TagIndex | undefined, ref: string): TagChip[] =>
  (index?.refs[ref] ?? []).map((name) => ({ name, color: index?.tags.find((t) => t.name === name)?.color ?? 0 }));

/** The active tag filter, kept in the URL. */
export function useActiveTag(): [string, (tag: string) => void] {
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag') ?? '';
  const set = (next: string) =>
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        if (next) q.set('tag', next);
        else q.delete('tag');
        return q;
      },
      { replace: true },
    );
  return [tag, set];
}

/**
 * The bar over a list: the tags its rows carry, one pressed. Hidden when no row
 * has a tag and none is active. `present` is every tag on the list's rows.
 */
export function TagFilterBar({ present, index, active, onPick, empty }: {
  present: readonly string[];
  index: TagIndex | undefined;
  active: string;
  onPick: (tag: string) => void;
  /** Nothing in the list carries the active tag. */
  empty: boolean;
}) {
  const names = [...new Set(active && !present.includes(active) ? [active, ...present] : present)];
  if (!names.length) return null;
  return (
    <div className={s.tagBar} role="toolbar" aria-label="Filter by tag">
      <span className={s.tagBarLabel}>Tags</span>
      {names.map((name) => {
        const on = name === active;
        const color = index?.tags.find((t) => t.name === name)?.color ?? 0;
        return (
          <button
            key={name}
            type="button"
            className={`${s.chip} ${s.chipBtn} ${colorClass(color)} ${on ? s.chipOn : ''}`}
            aria-pressed={on}
            title={on ? 'Show everything' : `Show only #${name}`}
            onClick={() => onPick(on ? '' : name)}
          >
            {name}
          </button>
        );
      })}
      {active && (
        <>
          <button type="button" className={s.linkBtn} onClick={() => onPick('')}>
            Clear
          </button>
          {empty && <span className={s.muted}>Nothing here is tagged #{active}.</span>}
        </>
      )}
    </div>
  );
}

/**
 * Chips with ×, a box, and suggestions from the project's own tags. Enter or a
 * comma adds; Backspace on an empty box removes the last chip; every change
 * is reported (a save). At most 12 tags, as the server keeps.
 */
export function TagEditor({ value, index, onChange }: { value: readonly string[]; index: TagIndex | undefined; onChange: (tags: string[]) => void }) {
  const [text, setText] = useState('');
  const [pick, setPick] = useState(-1);
  const [focused, setFocused] = useState(false);
  const q = normTag(text);
  const known = (index?.tags ?? []).map((t) => t.name).filter((n) => !value.includes(n));
  const options = known.filter((n) => !q || n.includes(q)).slice(0, 6);
  if (q && !known.includes(q) && !value.includes(q)) options.push(q);
  const add = (raw: string) => {
    const t = normTag(raw);
    setText('');
    setPick(-1);
    if (!t || value.includes(t) || value.length >= 12) return;
    onChange([...value, t]);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (options.length) setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(pick >= 0 && options[pick] ? options[pick] : text);
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const colorOf = (name: string) => index?.tags.find((t) => t.name === name)?.color ?? 0;
  const listId = useId();
  return (
    <div className={s.tagEdit}>
      <span className={s.chips}>
        {value.map((t) => (
          <span key={t} className={`${s.chip} ${colorClass(colorOf(t))}`}>
            {t}
            <button type="button" className={s.chipX} aria-label={`Remove tag ${t}`} onClick={() => onChange(value.filter((n) => n !== t))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
      </span>
      <input
        className={s.tagInput}
        value={text}
        placeholder={value.length ? 'Add a tag' : 'Add a tag — sales, finance…'}
        aria-label="Add a tag"
        role="combobox"
        aria-expanded={focused && options.length > 0}
        aria-controls={listId}
        aria-activedescendant={pick >= 0 ? `${listId}-${pick}` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setPick(-1);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKey}
      />
      {focused && options.length > 0 && (
        <div className={s.sugg} role="listbox" id={listId}>
          {options.map((name, i) => (
            <div
              key={name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === pick}
              className={`${s.suggRow} ${i === pick ? s.suggOn : ''}`}
              // mousedown, not click: the box's blur would take the list away first.
              onMouseDown={(e) => {
                e.preventDefault();
                add(name);
              }}
            >
              {!known.includes(name) && <span className={s.muted}>Create</span>}
              <Chip tag={{ name, color: colorOf(name) }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
