// The dock's chrome around the conversation: the top bar's toggle, the
// header (thread switcher, on/off pill, new, close) — dock.ts's header,
// ported — and the model picker under the composer. Which models there are is the org admin's (Admin → AI); which
// one answers is each member's own pick.

import { lazy, Suspense, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IconButton } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { listThreads, mineModel, PROVIDER_LABEL, setAssistantEnabled, setMyModel, type AiModel, type AiStatus, type Provider, type ThreadSummary } from './api';

const PROVIDER_ORDER: readonly Provider[] = ['anthropic', 'openai', 'gemini', 'gateway'];
import { setDockOpen, useDockOpen } from './dockState';
import s from './Dock.module.css';

export const TOGGLE_ID = 'dock-toggle';

const DockPanel = lazy(() => import('./Dock'));

/** The dock, beside the routed page while open. The panel loads on first open. */
export function Dock() {
  const open = useDockOpen();
  if (!open) return null;
  return (
    <Suspense fallback={<aside className={`${s.panel} ${s.loadingPanel}`} aria-label="Loading the Assistant" aria-busy="true" />}>
      <DockPanel />
    </Suspense>
  );
}

/** The top bar's Assistant button, and ⌘L / ⌘J (Ctrl elsewhere) — the dock's two doors. */
export function DockToggle() {
  const open = useDockOpen();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key !== 'l' && e.key !== 'j')) return;
      e.preventDefault();
      setDockOpen(!open);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <IconButton
      id={TOGGLE_ID}
      icon="sparkles"
      label="Assistant"
      title="Assistant — works on what you're looking at (⌘L)"
      aria-expanded={open}
      aria-controls="dock-panel"
      onClick={() => setDockOpen(!open)}
    />
  );
}

/** The header's active-conversation title; opens the project's conversations to switch to. */
export function ThreadMenu({ projectId, threadId, title, onOpen }: { projectId: string | null; threadId: string; title: string; onOpen: (id: string) => void }) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const items: MenuEntry[] =
    threads === null
      ? [{ label: 'Loading conversations…', disabled: true, onSelect: () => {} }]
      : threads.length === 0
        ? [{ label: 'No past conversations yet — ask something below', disabled: true, onSelect: () => {} }]
        : threads.map((t) => ({
            label: t.title || 'Conversation',
            icon: t.id === threadId ? 'check' : undefined,
            shortcut: t.turnCount === 1 ? '1 turn' : `${t.turnCount} turns`,
            onSelect: () => onOpen(t.id),
          }));
  return (
    <Menu
      label="Conversations"
      onOpenChange={(o) => {
        if (!o || !projectId) return;
        setThreads(null);
        void listThreads(projectId).then(setThreads, () => setThreads([]));
      }}
      trigger={
        <button type="button" className={s.threadTitle} aria-label={`Conversations — ${title}`} disabled={!projectId}>
          <Icon name="message-square" />
          <span className={s.threadText}>{title}</span>
          <Icon name="chevron-down" />
        </button>
      }
      items={items}
    />
  );
}

/** Assistant: On / Off — the org's switch, an admin's to flip. Not shown until a model is set up (the dock says why). */
export function AiPill({ status, isAdmin }: { status: AiStatus | undefined; isAdmin: boolean }) {
  const qc = useQueryClient();
  if (!status?.ready) return null;
  const on = status.copilotEnabled;
  return (
    <button
      type="button"
      className={on ? s.pill : `${s.pill} ${s.pillOff}`}
      aria-pressed={on}
      disabled={!isAdmin}
      title={isAdmin ? (on ? 'Turn the Assistant off' : 'Turn the Assistant on') : 'An org admin turns the Assistant on or off'}
      onClick={() => {
        void setAssistantEnabled(!on).then(
          () => qc.invalidateQueries({ queryKey: ['ai:status'] }),
          () => toast('Could not change the Assistant setting.', { kind: 'error' }),
        );
      }}
    >
      {on ? 'Assistant: On' : 'Assistant: Off'}
    </button>
  );
}

/** "Claude Sonnet 4.6 · Default", with the provider named when the list spans more than one. */
export function modelLabel(m: AiModel, models: readonly AiModel[]): string {
  const several = new Set(models.map((x) => x.provider)).size > 1;
  return `${m.label}${several ? ` (${PROVIDER_LABEL[m.provider]})` : ''}${m.isDefault ? ' · Default' : ''}`;
}

/**
 * Which model answers YOU: the models the org admin enabled, grouped by
 * provider, the default marked. The pick is saved on the server (`ai:setMine`),
 * so it follows you to every tab and every AI feature. With one model there is
 * nothing to choose — its name, as text.
 */
export function ModelPicker({ status }: { status: AiStatus | undefined }) {
  const qc = useQueryClient();
  const mine = mineModel(status);
  if (!status?.ready || !mine) return null;
  if (status.models.length === 1) {
    return (
      <span className={s.modelName} title={`Model: ${modelLabel(mine, status.models)}`}>
        {mine.label}
      </span>
    );
  }
  const order = [...status.models].sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider));
  return (
    <span className={s.modelPick}>
      <Select
        size="sm"
        aria-label="Model"
        value={`${mine.provider}/${mine.model}`}
        options={order.map((m) => ({ value: `${m.provider}/${m.model}`, label: modelLabel(m, status.models) }))}
        onValueChange={(v) => {
          const m = order.find((x) => `${x.provider}/${x.model}` === v);
          if (!m) return;
          void setMyModel(m.provider, m.model).then(
            (ok) => {
              if (!ok) toast('That model is no longer available. Pick another.', { kind: 'error' });
              return qc.invalidateQueries({ queryKey: ['ai:status'] });
            },
            () => toast('Could not change the model.', { kind: 'error' }),
          );
        }}
      />
    </span>
  );
}
