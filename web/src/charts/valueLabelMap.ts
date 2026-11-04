// Value labels as the chart engine draws them (semantic layer PR 06). A reply carries its STORED labels and series
// names with `valueLabels` pairs beside them ("EU" → "Europe"): the engine draws the label, and every click, pin,
// hover, drill, custom order, colour and annotation keeps the stored value. The rules are the server's pure leaf
// (src/analysis/valueLabels.ts). Not ./valueLabels, which draws the figures on the marks.

import * as OrdFormat from '../../../src/app/format.ts';
import { rawOf, shownText, type ValueLabelPairs } from '../../../src/analysis/valueLabels.ts';
import type { ChartDataShape, Cx } from './types';

export { rawOf, shownText, type ValueLabelPairs };

/** The axis text for the server's labels: a first-of-month axis as "Jan 2023" (asMonthLabels), then each value by its label. */
export function drawnLabels(labels: readonly Cx[] | undefined, pairs?: ValueLabelPairs): Cx[] {
  return shownText(OrdFormat.asMonthLabels(Array.isArray(labels) ? [...labels] : []), pairs?.category);
}

/** A series name as drawn. */
export const shownName = (name: Cx, pairs?: ValueLabelPairs): Cx => shownText([name], pairs?.series)[0];

/** A reply as people read it: labels and series names by their labels, `valueLabels` gone. Without pairs, the same object. */
export function shownData<D extends ChartDataShape>(data: D): D {
  const p = data.valueLabels;
  if (!p) return data;
  const { valueLabels: _pairs, ...rest } = data;
  return {
    ...rest,
    ...(Array.isArray(data.labels) ? { labels: shownText(data.labels, p.category) } : {}),
    ...(Array.isArray(data.series) && p.series ? { series: data.series.map((s) => ({ ...s, name: shownName(s.name, p) })) } : {}),
  } as D;
}
