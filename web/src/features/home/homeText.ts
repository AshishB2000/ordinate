// Home's words — pure functions, ported from homeAsk.ts / homePage.ts. Every
// figure here is one the server returned; these only write it out.

import type { RecentItem, RecentType } from '../../api/home';
import type { IconName } from '../../ui/icons/Icon';

export const TYPE_LABEL: Record<RecentType, string> = {
  dataset: 'Dataset',
  analysis: 'Dashboard',
  capture: 'Capture',
  report: 'Report',
  visual: 'Visual',
};

/** The name to greet: an email's local part up to the first separator, capitalised ("ana.ruiz@x" → "Ana"). */
export function displayName(email: string | undefined): string {
  const first = (email ?? '').split('@')[0]!.split(/[._+-]/)[0]!.trim();
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

/** haGreetingText: the same thresholds (5/12/17/22); with no name, nobody to greet. */
export function greeting(name: string, hour: number): string {
  if (!name) return 'Welcome back';
  if (hour >= 5 && hour < 12) return `Good morning, ${name}`;
  if (hour >= 12 && hour < 17) return `Good afternoon, ${name}`;
  if (hour >= 17 && hour < 22) return `Good evening, ${name}`;
  return `Good to see you, ${name}`; // late night — "Good night" reads as a goodbye
}

const num = new Intl.NumberFormat();

/** "1 dataset" / "3 datasets", the count as the server gave it. */
export function plural(n: number, word: string): string {
  return `${num.format(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** homeMetaText: what a Recent row IS — "1,240 rows × 5 columns", "3 sheets", or ''. */
export function metaText(it: Pick<RecentItem, 'type' | 'meta'>): string {
  const m = it.meta ?? {};
  if (it.type === 'dataset') {
    const parts: string[] = [];
    if (typeof m.rowCount === 'number') parts.push(plural(m.rowCount, 'row'));
    if (typeof m.columnCount === 'number') parts.push(plural(m.columnCount, 'column'));
    return parts.join(' × ');
  }
  if (it.type === 'analysis' && typeof m.sheetCount === 'number') return plural(m.sheetCount, 'sheet');
  return '';
}

/** dsRules dqDot's label; '' when nothing fails. */
export function qualityLabel(failing: number | undefined): string {
  if (typeof failing !== 'number' || failing <= 0) return '';
  return `Data quality: ${num.format(failing)} ${failing === 1 ? 'rule' : 'rules'} failing`;
}

// i18n-skip: a dataset NAME — src/app/sampleProject.ts SAMPLE_DATASET_NAME.
export const SAMPLE_DATASET = 'Retail orders';

/** A suggestion under Home's ask bar: its sentence, its glyph, and the dataset the sentence names. */
export interface Starter {
  text: string;
  icon: IconName;
  /** The Assistant is pointed at this dataset, as the dock's `@` points it. */
  about: { id: string; name: string };
}

/**
 * haSuggestPrompts: Home's suggestions from the project's REAL datasets, strings
 * only, never a figure, never a model call. Each names ONE dataset (the dock's
 * `@` points at one thing), asks or builds, and building is offered only to an
 * editor. The bundled sample gets sentences written for it.
 */
export function suggestPrompts(datasets: ReadonlyArray<{ id: string; name: string }>, canEdit: boolean): Starter[] {
  const named = datasets.map((d) => ({ id: d.id, name: d.name.trim() })).filter((d) => d.name);
  const [a, b] = named;
  if (!a) return [];
  const out: Starter[] = [];
  if (named.length === 1 && a.name === SAMPLE_DATASET) {
    out.push({ text: `Which region had the worst month in ${a.name}?`, icon: 'trending-up', about: a });
    out.push({ text: `Chart revenue by category in ${a.name}`, icon: 'chart-bar', about: a });
    if (canEdit) out.push({ text: `Build a dashboard from ${a.name}`, icon: 'layout-dashboard', about: a });
    return out;
  }
  if (canEdit) {
    out.push({ text: `Build a dashboard from ${a.name}`, icon: 'layout-dashboard', about: a });
    out.push({ text: `Clean up ${a.name}`, icon: 'filter', about: a });
  }
  out.push({ text: `Summarise ${a.name}`, icon: 'file-text', about: a });
  if (b) out.push({ text: `What is in ${b.name}?`, icon: 'table', about: b });
  return out;
}

/** Where a Recent row opens: the record itself where it has a page, else its section. */
export function itemHref(it: Pick<RecentItem, 'type' | 'id' | 'projectId'>): string {
  switch (it.type) {
    case 'dataset':
      return `/data/${it.projectId}/${it.id}`;
    case 'analysis':
      return `/analyses/${it.projectId}/${it.id}`;
    case 'visual':
      return `/visuals/${it.projectId}/${it.id}`;
    case 'report':
      return '/reports';
    default:
      return '/data';
  }
}

/** The import page in `projectId` (the current project when there is none yet), on one source. */
export function importPath(projectId: string | undefined, source?: string): string {
  const q = new URLSearchParams();
  if (projectId) q.set('project', projectId);
  if (source) q.set('source', source);
  return q.size ? `/data/import?${q.toString()}` : '/data/import';
}
