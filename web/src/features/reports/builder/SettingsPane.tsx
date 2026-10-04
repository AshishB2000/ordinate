// The builder's right pane (reportBuilder.ts rbLoadSettings / rbReadSettings):
// name, format, cover, paper (not for a deck — always 16:9), the filter line,
// a saved view, the Narrative and Discussion pages. Text fields commit on blur
// so the preview is not re-resolved on every keystroke.

import { useState } from 'react';
import { Checkbox, Switch } from '../../../ui/Choice';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { Icon } from '../../../ui/icons/Icon';
import type { OpenReport, Report } from '../api';
import s from './Builder.module.css';

function CommitInput({ label, value, onCommit, placeholder }: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setV(value);
  }
  return (
    <Input
      label={label}
      value={v}
      placeholder={placeholder}
      maxLength={200}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function SettingsPane({ report, views, onChange }: { report: Report; views: OpenReport['views']; onChange: (patch: Partial<Report>) => void }) {
  const pptx = report.format === 'pptx';
  const viewOptions = [
    { value: '', label: 'As saved (no view)' },
    ...views.map((v) => ({ value: v.id, label: v.name })),
    ...(views.length > 1 ? [{ value: 'all', label: 'Every view, one section each' }] : []),
  ];
  return (
    <aside className={s.settingsPane} aria-label="Report settings">
      <div className={s.paneHead}>
        <span className={s.paneTitle}>Settings</span>
      </div>
      <div className={s.settings}>
        <CommitInput label="Report name" value={report.name} onCommit={(name) => onChange({ name: name.trim() || report.name })} />
        <Select
          label="Format"
          value={report.format}
          onValueChange={(v) => onChange({ format: v as Report['format'] })}
          options={[
            { value: 'pdf', label: 'PDF' },
            { value: 'pptx', label: 'PowerPoint (.pptx)' },
            { value: 'docx', label: 'Word (.docx)' },
          ]}
        />
        <fieldset className={s.group}>
          <legend>Cover</legend>
          <CommitInput label="Title" value={report.cover.title} onCommit={(title) => onChange({ cover: { ...report.cover, title: title.trim() || report.name } })} />
          <CommitInput label="Subtitle" value={report.cover.subtitle || ''} placeholder="Optional" onCommit={(subtitle) => onChange({ cover: { ...report.cover, subtitle: subtitle.trim() } })} />
          <Checkbox label="Show the logo" checked={report.cover.logo !== false} onCheckedChange={(logo) => onChange({ cover: { ...report.cover, logo } })} />
          <Checkbox label="Print the dashboard’s filters" checked={report.includeFilters !== false} onCheckedChange={(includeFilters) => onChange({ includeFilters })} />
        </fieldset>
        {pptx ? (
          <p className={s.note}>
            <Icon name="info" size={12} /> Slides are always 16:9 — paper size does not apply.
          </p>
        ) : (
          <fieldset className={s.group}>
            <legend>Paper</legend>
            <div className={s.pair}>
              <Select
                label="Size"
                value={report.paper.size}
                onValueChange={(size) => onChange({ paper: { ...report.paper, size: size as Report['paper']['size'] } })}
                options={[
                  { value: 'letter', label: 'Letter' },
                  { value: 'a4', label: 'A4' },
                ]}
              />
              <Select
                label="Orientation"
                value={report.paper.orientation}
                onValueChange={(o) => onChange({ paper: { ...report.paper, orientation: o as Report['paper']['orientation'] } })}
                options={[
                  { value: 'portrait', label: 'Portrait' },
                  { value: 'landscape', label: 'Landscape' },
                ]}
              />
            </div>
          </fieldset>
        )}
        <Select
          label="Saved view"
          value={report.viewId || ''}
          disabled={!views.length}
          hint={views.length ? 'Print under a view’s filters and parameters.' : 'This dashboard has no saved views.'}
          onValueChange={(viewId) => onChange({ viewId })}
          options={viewOptions}
        />
        <fieldset className={s.group}>
          <legend>Extra pages</legend>
          <Switch
            label="Narrative"
            hint="Two paragraphs the Assistant writes from the app’s own sentences. Dropped when no model answers in time."
            checked={report.narrative}
            onCheckedChange={(narrative) => onChange({ narrative })}
          />
          <Switch label="Discussion" hint="The dashboard’s comment threads, printed last." checked={report.discussion} onCheckedChange={(discussion) => onChange({ discussion })} />
        </fieldset>
        <p className={s.note}>
          <Icon name="calendar" size={12} /> Scheduled delivery is not available in the browser yet — generate the file when you need it.
        </p>
      </div>
    </aside>
  );
}
