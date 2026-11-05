// A line under "Count distinct" when it would give Count's number: the column is the table's key and the last key
// check found no repeats. It reads only `key` and `keyCheck.repeatedKeys` of the table notes (a viewer whose rows are
// restricted gets no `keyCheck`, so no hint), and it never changes the aggregation: the button asks the editor to.

import { useTableDoc } from '../../data/tableApi';
import { Button } from '../../../ui/Button';
import s from './Metrics.module.css';

type Props = { projectId: string; datasetId: string; column: string; aggregation: string; onUseCount: () => void };

export function KeyHint(props: Props) {
  return props.aggregation === 'countd' && props.datasetId && props.column ? <Hint {...props} /> : null;
}

function Hint({ projectId, datasetId, column, onUseCount }: Props) {
  const t = useTableDoc(projectId, datasetId).data;
  if (!t || t.key !== column || t.keyCheck?.repeatedKeys !== 0) return null;
  return (
    <p className={s.keyHint}>
      Each {column} appears once, so Count gives the same number.{' '}
      <Button size="sm" variant="ghost" onClick={onUseCount}>
        Use Count
      </Button>
    </p>
  );
}
