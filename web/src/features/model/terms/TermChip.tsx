// A glossary term as a filter row, pill or chip names it: its name, read from the project's one
// `term:list`. Inert — the term is edited in the Data model's Glossary, never in place.

import { Icon } from '../../../ui/icons/Icon';
import { termLabel, useTerms } from './api';
import s from './Terms.module.css';

export function TermChip({ projectId, term }: { projectId: string; term: string }) {
  const terms = useTerms(projectId);
  const name = termLabel(terms.data, term);
  return (
    <span className={s.chip} title={terms.data?.find((t) => t.id === term)?.definition}>
      <Icon name="list" size={12} />
      <span className={s.chipText}>{name}</span>
    </span>
  );
}
