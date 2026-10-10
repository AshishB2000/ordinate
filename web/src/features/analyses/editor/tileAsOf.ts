// A card's freshness caption (L0.2) lives in its HEAD, beside the title, while
// the time it shows arrives with the BODY's figure (`asOf` on each tile reply).
// The card frame (CardView) provides a slot; the body reports into it. In the
// head it never takes a pixel from a KPI's figure or a chart, and it reads the
// same on every kind of tile, Present mode included.
//
// Outside a card (a list card's preview, a draft's) there is no slot and the
// report goes nowhere.

import { createContext, useContext, useEffect } from 'react';
import type { AsOf } from '../../../ui/asOfView';

type Report = (asOf: AsOf | undefined) => void;

export const TileAsOfSlot = createContext<Report | null>(null);

/** Shows `asOf` in the enclosing card's head for as long as this body shows its figure. */
export function useTileAsOf(asOf: AsOf | undefined): void {
  const report = useContext(TileAsOfSlot);
  // By value: a refetch hands back an equal object, which must not re-render the head.
  const key = asOf ? JSON.stringify(asOf) : '';
  useEffect(() => {
    if (!report) return;
    report(key ? (JSON.parse(key) as AsOf) : undefined);
    return () => report(undefined);
  }, [report, key]);
}
