import { t } from '../app/i18n';
// The published page's server-written words (src/publish/) — catalog sentences
// (scripts/i18n-extract.ts MAIN_FILES), in the org's language.

/** What a KPI tile measures, under its figure: "Sum of revenue". */
export function kpiMeasure(aggregation: string, column: string): string {
  switch (aggregation) {
    case 'sum': return t('driverPointMessages.sum_of', { column });
    case 'avg': return t('driverPointMessages.average_of', { column });
    case 'count': return t('driverPointMessages.count_of', { column });
    case 'min': return t('publishMessages.minimum_of', { column });
    case 'max': return t('publishMessages.maximum_of', { column });
    default: return column;
  }
}
