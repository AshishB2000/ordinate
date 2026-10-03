// The dock's chrome around the conversation: the top bar's toggle, the
// header (thread switcher, on/off pill, new, close) and the composer's model
// chip — dock.ts's header and execMenu.ts's cloud rows, ported. The local-CLI
// rows of the model menu are gone: a server runs API-key providers only.

import { lazy, Suspense, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IconButton } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { toast } from '../../ui/Toast';
import { activateProvider, listThreads, PROVIDER_LABEL, setAssistantEnabled, type KeyStatus, type Provider, type ThreadSummary } from './api';
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

/** Not set up / Assistant: On / Off. With no model there is nothing to toggle, so it says so and leads to the fix. */
export function AiPill({ status, isAdmin, onSetUp }: { status: KeyStatus | undefined; isAdmin: boolean; onSetUp: () => void }) {
  const qc = useQueryClient();
  if (!status) return null;
  if (!status.isReady) {
    return (
      <button type="button" className={`${s.pill} ${s.pillNone}`} title="The Assistant isn't set up yet." onClick={onSetUp}>
        Not set up
      </button>
    );
  }
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
          () => qc.invalidateQueries({ queryKey: ['key:status'] }),
          () => toast('Could not change the Assistant setting.', { kind: 'error' }),
        );
      }}
    >
      {on ? 'Assistant: On' : 'Assistant: Off'}
    </button>
  );
}

/** The composer's model chip: which provider answers, and (admins) switching to another connected one. */
export function ModelChip({ status, isAdmin, onConnect }: { status: KeyStatus; isAdmin: boolean; onConnect: () => void }) {
  const qc = useQueryClient();
  const active = status.byok.activeProvider;
  const rows = status.allowedProviders.filter((p) => status.byok.providers[p]?.connected);
  const items: MenuEntry[] = [
    { kind: 'heading', label: 'Model provider' },
    {
      kind: 'radio',
      label: 'Model provider',
      value: active ?? '',
      options: rows.map((p) => ({ value: p, label: PROVIDER_LABEL[p] })),
      onChange: (v) => {
        if (!isAdmin) return;
        void activateProvider(v as Provider).then((ok) => {
          if (!ok) toast('That provider is not connected.', { kind: 'error' });
          void qc.invalidateQueries({ queryKey: ['key:status'] });
        });
      },
    },
    ...(isAdmin ? ([{ kind: 'separator' }, { label: 'Connect a provider…', icon: 'plug', onSelect: onConnect }] as MenuEntry[]) : []),
  ];
  return (
    <Menu
      label="Model provider"
      side="top"
      trigger={
        <button type="button" className={s.model} aria-label={`Model: ${active ? PROVIDER_LABEL[active] : 'none'}`}>
          <Icon name="sparkles" size={12} />
          {active ? PROVIDER_LABEL[active] : 'No model'}
          <Icon name="chevron-down" size={12} />
        </button>
      }
      items={items}
    />
  );
}
