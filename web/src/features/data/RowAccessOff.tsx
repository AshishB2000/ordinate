// What a viewer sees where row access rules limit them (docs/row-policy): a
// quiet chip on the dataset's header, and — on the tabs that read every row —
// the designed off state that says why, instead of asking and failing.

import { Icon } from '../../ui/icons/Icon';
import { EmptyState } from '../../ui/States';
import s from './RowAccess.module.css';

export function ScopedChip() {
  return (
    <span className={s.scoped} title="Row access rules limit the rows you see in this dataset">
      <Icon name="lock" size={12} />
      Rows limited to your access
    </span>
  );
}

export function RowAccessOff({ what }: { what: string }) {
  return (
    <EmptyState heading={3} icon="lock" title={`${what} are off for your access`}>
      They read every row of this dataset, and your access covers only some of its rows. Charts, tables and filters show the rows you can see.
    </EmptyState>
  );
}
