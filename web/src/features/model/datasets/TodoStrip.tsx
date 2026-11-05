// "To fill in next": the gaps that matter most, as one-click chips that open the record where it is
// filled in. The server picks and ranks them (`model:overview`, `sourceTable:list`); this only words
// them. An editor's only: a viewer can fill in nothing.

import { Icon, type IconName } from '../../../ui/icons/Icon';
import { formatNumber } from '../../data/format';
import { reviewText, todoText, type ReviewItem, type TodoItem } from '../api';
import m from '../Model.module.css';

export interface StripItem {
  id: string;
  text: string;
  warn?: boolean;
  /** Drawn before the text; a warn chip without one shows the alert. */
  icon?: IconName;
}

/** The strip itself, for any tab: worded chips, then "+N more". Nothing to fill in, no strip. */
export function ChipStrip({ items, more, onPick }: { items: StripItem[]; more: number; onPick: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <section className={m.strip} aria-label="To fill in next">
      <span className={m.stripHead}>
        <Icon name="list" size={16} />
        To fill in next
      </span>
      {items.map((item) => {
        const icon = item.icon ?? (item.warn ? 'alert' : undefined);
        return (
          <button key={item.id} type="button" className={item.warn ? `${m.chip} ${m.chipWarn}` : m.chip} onClick={() => onPick(item.id)}>
            {icon && <Icon name={icon} size={12} />}
            {item.text}
          </button>
        );
      })}
      {more > 0 && <span className={m.more}>{`+${formatNumber(more)} more`}</span>}
    </section>
  );
}

const EXTRA = '*suggested';

/** The Datasets tab's strip: the server's gaps, then what an admin should review (part 4); `extra` is one more chip after the server's. */
export function TodoStrip({ todo, review = [], more, nameOf, onOpen, onReview, extra }: { todo: TodoItem[]; review?: ReviewItem[]; more: number; nameOf: (id: string) => string | undefined; onOpen: (item: TodoItem) => void; onReview?: (item: ReviewItem) => void; extra?: { text: string; onPick: () => void } }) {
  const key = (item: TodoItem) => `${item.datasetId}:${item.kind}`;
  const items = todo.flatMap((item): StripItem[] => {
    const name = item.kind === 'verified_broken' ? '' : nameOf(item.datasetId); // the project's, not a dataset's
    return name === undefined ? [] : [{ id: key(item), text: todoText(item, name), warn: item.kind === 'key_repeats' || item.kind === 'verified_broken' }]; // gone from the list since the server ranked it
  });
  for (const item of review) items.push({ id: `review:${item.ref}`, text: reviewText(item), warn: item.kind === 'needs_review', icon: item.kind === 'needs_review' ? 'alert' : 'archive' });
  if (extra) items.push({ id: EXTRA, text: extra.text });
  return <ChipStrip items={items} more={more} onPick={(id) => {
    if (id === EXTRA) return extra?.onPick();
    const r = review.find((x) => `review:${x.ref}` === id);
    if (r) return onReview?.(r);
    const item = todo.find((t) => key(t) === id);
    if (item) onOpen(item);
  }} />;
}
