// "To fill in next": the gaps that matter most, as one-click chips that open the dataset where it is
// filled in. The server picks and ranks them (`model:overview`); this only words them. An editor's
// only: a viewer can fill in nothing.

import { Icon } from '../../../ui/icons/Icon';
import { formatNumber } from '../../data/format';
import { reviewText, todoText, type ReviewItem, type TodoItem } from '../api';
import m from '../Model.module.css';

export function TodoStrip({ todo, review = [], more, nameOf, onOpen, onReview }: { todo: TodoItem[]; review?: ReviewItem[]; more: number; nameOf: (id: string) => string | undefined; onOpen: (item: TodoItem) => void; onReview?: (item: ReviewItem) => void }) {
  if (!todo.length && !review.length) return null;
  return (
    <section className={m.strip} aria-label="To fill in next">
      <span className={m.stripHead}>
        <Icon name="list" size={16} />
        To fill in next
      </span>
      {todo.map((item) => {
        const name = nameOf(item.datasetId);
        if (name === undefined) return null; // gone from the list since the server ranked it
        const warn = item.kind === 'key_repeats';
        return (
          <button key={`${item.datasetId}:${item.kind}`} type="button" className={warn ? `${m.chip} ${m.chipWarn}` : m.chip} onClick={() => onOpen(item)}>
            {warn && <Icon name="alert" size={12} />}
            {todoText(item, name)}
          </button>
        );
      })}
      {review.map((item) => (
        <button key={item.ref} type="button" className={`${m.chip} ${item.kind === 'needs_review' ? m.chipWarn : ''}`} onClick={() => onReview?.(item)}>
          <Icon name={item.kind === 'needs_review' ? 'alert' : 'archive'} size={12} />
          {reviewText(item)}
        </button>
      ))}
      {more > 0 && <span className={m.more}>{`+${formatNumber(more)} more`}</span>}
    </section>
  );
}
