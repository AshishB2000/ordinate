// What one Recent record shows on Home — its icon, its key among the caller's
// pins, its detail line — shared by the preview cards and the table. Words
// only: every figure is one the server sent.

import type { RecentItem, RecentType } from '../../api/home';
import type { IconName } from '../../ui/icons/Icon';
import { typeLabel } from '../visuals/model';
import { metaText } from './homeText';

export const TYPE_ICON: Record<RecentType, IconName> = {
  dataset: 'database',
  analysis: 'layout-dashboard',
  capture: 'camera',
  report: 'file-text',
  visual: 'chart-bar',
};

/** A record's key in the caller's pins ("type:id"). */
export const starKey = (it: Pick<RecentItem, 'type' | 'id'>) => `${it.type}:${it.id}`;

/** What the record IS: a dataset's size, a dashboard's sheets, a visual's chart type — or ''. */
export function detailText(it: Pick<RecentItem, 'type' | 'meta'>): string {
  if (it.type === 'visual') return it.meta?.chartType ? typeLabel(it.meta.chartType) : '';
  return metaText(it);
}
