// The question ⇄ the URL (docs/explore/00-design.md): `?project=&dataset=&q=`.
// Reading decodes the shape only (./spec); every edit PUSHES a history entry,
// so Back and Forward step through the questions asked and a copied link opens
// on the same one. The server validates whatever the link says.

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { decodeQuestion, EMPTY, encodeQuestion, type Question } from './spec';

export function useExploreSpec() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('q');
  const question = useMemo(() => decodeQuestion(raw) ?? EMPTY, [raw]);
  const setQuestion = useCallback(
    (next: Question) =>
      setParams((p) => {
        const n = new URLSearchParams(p);
        const e = next.encoding;
        if (e.category || e.values.length || next.filters.length) n.set('q', encodeQuestion(next));
        else n.delete('q');
        return n;
      }),
    [setParams],
  );
  return { question, setQuestion };
}
