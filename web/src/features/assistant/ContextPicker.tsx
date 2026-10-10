// The composer's `@`: point the Assistant at ONE thing in the project — a
// dataset, a visual or an analysis — instead of whatever is on screen. The pick
// is only a `{ kind, id }` reference: the server resolves it inside the project
// and computes every fact about it (src/ipc/copilot.ts buildFacts). The search
// filters NAMES only.

import { useState } from 'react';
import { useDatasets } from '../../api/datasets';
import { IconButton } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Popover } from '../../ui/Popover';
import { SkeletonRows } from '../../ui/Skeleton';
import { useAnalysisNames, useVisualNames, type Mentionable } from './api';
import type { DockContext } from './dockState';
import s from './DockList.module.css';

type Kind = 'dataset' | 'visual' | 'analysis';

/** The glyph a context wears, in the picker and on the composer's chip. */
export const CONTEXT_ICON: Record<string, IconName> = { dataset: 'table', visual: 'chart-bar', analysis: 'layout-dashboard' };

const refTo = (kind: Kind, m: Mentionable): DockContext => ({ kind, id: m.id, label: `${kind} · ${m.name}`, name: m.name });

/** The open picker's body — mounted only while open, so the lists are asked for only then. */
function Choices({ projectId, onPick }: { projectId: string; onPick: (c: DockContext | null) => void }) {
  const datasets = useDatasets(projectId);
  const visuals = useVisualNames(projectId);
  const analyses = useAnalysisNames(projectId);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const lists = [
    { kind: 'dataset' as const, label: 'Datasets', q: datasets },
    { kind: 'visual' as const, label: 'Visuals', q: visuals },
    { kind: 'analysis' as const, label: 'Analyses', q: analyses },
  ];
  const groups = lists.map((l) => ({ ...l, items: ((l.q.data ?? []) as Mentionable[]).filter((m) => m.name.toLowerCase().includes(needle)) })).filter((g) => g.items.length > 0);
  const loading = lists.some((l) => l.q.isPending);
  const failed = lists.some((l) => l.q.isError);
  const first = groups[0];
  return (
    <>
      <Input
        size="sm"
        icon="search"
        aria-label="Search the project"
        placeholder="Search datasets, visuals, analyses"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter takes the first match: `@`, a few letters, Enter.
          if (e.key !== 'Enter' || !first) return;
          e.preventDefault();
          onPick(refTo(first.kind, first.items[0]));
        }}
      />
      <div className={s.list}>
        {!needle && (
          <button type="button" className={s.row} onClick={() => onPick(null)}>
            <Icon name="eye" />
            <span className={s.rowTitle}>What’s on screen</span>
            <span className={s.rowMeta}>Default</span>
          </button>
        )}
        {groups.map((g) => (
          <section key={g.kind} className={s.group} aria-label={g.label}>
            <h3 className={s.groupLabel}>{g.label}</h3>
            {g.items.map((m) => (
              <button key={m.id} type="button" className={s.row} onClick={() => onPick(refTo(g.kind, m))}>
                <Icon name={CONTEXT_ICON[g.kind]} />
                <span className={s.rowTitle}>{m.name}</span>
              </button>
            ))}
          </section>
        ))}
        {loading && <SkeletonRows rows={3} label="Loading the project" />}
        {!loading && groups.length === 0 && <p className={s.empty}>{needle ? 'Nothing in this project matches that search.' : 'This project has nothing to point at yet. Bring data in to start.'}</p>}
        {failed && <p className={s.empty}>Part of the project could not be listed. Close this and try again.</p>}
      </div>
    </>
  );
}

export interface ContextPickerProps {
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A reference to pin, or `null` to follow the screen again. */
  onPick: (c: DockContext | null) => void;
  /** Focus goes back to the composer, not to the `@` button. */
  onClosed: () => void;
}

export function ContextPicker({ projectId, open, onOpenChange, onPick, onClosed }: ContextPickerProps) {
  return (
    <Popover
      title="Point the Assistant at"
      side="top"
      align="end"
      className={s.popover}
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        onClosed();
      }}
      trigger={<IconButton icon="at-sign" size="sm" label="Point the Assistant at something" title="Point the Assistant at something (@)" disabled={!projectId} />}
    >
      {projectId && (
        <Choices
          projectId={projectId}
          onPick={(c) => {
            onPick(c);
            onOpenChange(false);
          }}
        />
      )}
    </Popover>
  );
}
