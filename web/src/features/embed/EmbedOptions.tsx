// What an embed token says beyond the dashboard: the locks, the theme, which
// of the page's chrome to leave out. Shared by Admin → Embedding's preview and
// a link's Embed dialog; the parent keeps the state (it signs and previews it).

import { Checkbox } from '../../ui/Choice';
import { Select } from '../../ui/Select';
import { useEmbedColumns, type Hide, type Lock, type LockColumn } from './api';
import { LockPicker } from './LockPicker';
import s from './Embed.module.css';

export interface EmbedChoice {
  locks: Lock[];
  theme: '' | 'light' | 'dark';
  hide: Hide[];
}

export const NO_CHOICE: EmbedChoice = { locks: [], theme: '', hide: [] };

/** The columns the picker offers, for turning locks into a token's `params`. */
export function useLockColumns(projectId: string, siteId: string, dashboardId: string | null): { query: ReturnType<typeof useEmbedColumns>; columns: LockColumn[] } {
  const query = useEmbedColumns(projectId, siteId, dashboardId);
  return { query, columns: query.data?.ok ? query.data.columns : [] };
}

export function EmbedOptions({ query, value, onChange }: { query: ReturnType<typeof useEmbedColumns>; value: EmbedChoice; onChange: (v: EmbedChoice) => void }) {
  const toggle = (part: Hide, on: boolean) => onChange({ ...value, hide: on ? [...value.hide, part] : value.hide.filter((h) => h !== part) });
  return (
    <>
      <section className={s.stack} aria-label="Locked filters">
        <h4 className={s.sectionTitle}>Locked filters</h4>
        <LockPicker columns={query} locks={value.locks} onChange={(locks) => onChange({ ...value, locks })} />
      </section>
      <section className={s.stack} aria-label="Appearance">
        <h4 className={s.sectionTitle}>Appearance</h4>
        <div className={s.options}>
          <Select
            aria-label="Theme"
            value={value.theme || 'own'}
            onValueChange={(v) => onChange({ ...value, theme: v === 'own' ? '' : (v as 'light' | 'dark') })}
            options={[
              { value: 'own', label: 'The dashboard’s own theme' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
          <Checkbox label="Hide the title" checked={value.hide.includes('title')} onCheckedChange={(on) => toggle('title', on)} />
          <Checkbox label="Hide the filter bar" checked={value.hide.includes('filters')} onCheckedChange={(on) => toggle('filters', on)} />
        </div>
      </section>
    </>
  );
}
