// A dashboard on a phone, PURE (docs/phone-dashboards): the phone layout's
// tiles in the order it shows them (geometry.ts resolve — the grid read row
// by row then left to right, or the author's own phone order), with each run
// of consecutive KPI cards folded into one swipeable strip. A lone KPI stays
// a card; a run never crosses into or out of a group (a container's KPIs
// strip together, under its heading).
//
// The published page folds the same way (src/publish/site/publishCore.ts
// pkPhoneBlocks).

import type { Card } from '../../analyses/api';

export type PhoneBlock = { kind: 'strip'; ids: string[] } | { kind: 'card'; id: string };

export function phoneBlocks(order: readonly { id: string }[], cards: readonly Card[]): PhoneBlock[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out: PhoneBlock[] = [];
  let run: Card[] = [];
  const flush = () => {
    if (run.length > 1) out.push({ kind: 'strip', ids: run.map((c) => c.id) });
    else if (run.length === 1) out.push({ kind: 'card', id: run[0].id });
    run = [];
  };
  for (const { id } of order) {
    const card = byId.get(id);
    if (!card) continue;
    if (card.type !== 'metric') {
      flush();
      out.push({ kind: 'card', id });
      continue;
    }
    if (run.length && run[0].parentId !== card.parentId) flush();
    run.push(card);
  }
  flush();
  return out;
}

/**
 * The reader on a phone: the dashboard is phone-wide and the author did not
 * PIN the phone size (a desktop author's pinned preview keeps the arranging
 * tools — that is where a phone layout is made).
 */
export const isPhoneReader = (ed: { size: string; pinned: unknown }): boolean => ed.size === 'phone' && !ed.pinned;
