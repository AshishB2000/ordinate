// A row's status as a coloured dot with its word for assistive tech (scorecardPage.ts scDot).

import { STATUS_WORD, type RowStatus } from '../api';
import s from './Scorecard.module.css';

export function Dot({ status }: { status: RowStatus }) {
  return <span className={`${s.dot} ${s[status]}`} role="img" aria-label={STATUS_WORD[status]} title={STATUS_WORD[status]} />;
}
