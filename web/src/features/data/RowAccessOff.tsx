// What a viewer sees where row access rules limit them (docs/row-policy), or a column rule hides columns
// from them (semantic layer part 4): a
// quiet chip on the dataset's header, and — on the tabs that read every row —
// the designed off state that says why, instead of asking and failing.

import { Icon } from '../../ui/icons/Icon';
import { EmptyState } from '../../ui/States';
import s from './RowAccess.module.css';

/** `columns`: a column rule hides columns from this viewer (the header marks them), whether or not rows are limited too. */
export function ScopedChip({ columns = false }: { columns?: boolean }) {
  return (
    <span className={s.scoped} title={columns ? 'Access rules limit what you see in this dataset: some of its columns are hidden from you' : 'Row access rules limit the rows you see in this dataset'}>
      <Icon name="lock" size={12} />
      {columns ? 'Limited to your access' : 'Rows limited to your access'}
    </span>
  );
}

export function RowAccessOff({ what, columns = false }: { what: string; columns?: boolean }) {
  return (
    <EmptyState heading={3} icon="lock" title={`${what} are off for your access`}>
      {columns
        ? 'They read the whole dataset, and some of its columns are hidden from you. Charts, tables and filters show what you can see.'
        : 'They read every row of this dataset, and your access covers only some of its rows. Charts, tables and filters show the rows you can see.'}
    </EmptyState>
  );
}
