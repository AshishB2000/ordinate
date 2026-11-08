// The dock's chrome around the conversation: the top bar's toggle, the
// header's thread switcher and ⋯ menu (new, History and close sit beside them
// in Dock.tsx) and the model picker under the composer. Which models there are is the org admin's (Admin → AI); which
// one answers is each member's own pick.

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { IconButton } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { mineModel, PROVIDER_LABEL, setAssistantEnabled, setMyModel, threadTitle, turnsLabel, useThreads, type AiModel, type AiStatus, type Provider, type Turn } from './api';

const PROVIDER_ORDER: readonly Provider[] = ['anthropic', 'openai', 'gemini', 'gateway'];
import { setDockOpen, useDockOpen } from './dockState';
import type { ThreadAct, ThreadRef } from './ThreadActions';
import s from './Dock.module.css';

export const TOGGLE_ID = 'dock-toggle';

/** The Assistant full width (AssistantPage.tsx): the same conversation as the dock, where the dock is not drawn. */
export const ASSISTANT_PATH = '/assistant';

const DockPanel = lazy(() => import('./Dock'));

function useOnAssistantPage(): boolean {
  return useLocation().pathname === ASSISTANT_PATH;
}

/**
 * From the full-width Assistant back to the side panel: the dock opens (on the page's conversation, which the page
 * remembers for it) and the screen before comes back — Home when the page was the first thing opened, so Back
 * never leaves the app. The browser router keeps the entry's place in history.state (`idx`, 0 the first; a
 * replace keeps it, where it would change location.key).
 */
export function useBackToDock(): () => void {
  const navigate = useNavigate();
  return () => {
    setDockOpen(true);
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    void (idx > 0 ? navigate(-1) : navigate('/'));
  };
}

/** The dock, beside the routed page while open — not beside the full-width Assistant. The panel loads on first open. */
export function Dock() {
  const open = useDockOpen();
  const onPage = useOnAssistantPage();
  if (!open || onPage) return null;
  return (
    <Suspense fallback={<aside className={`${s.panel} ${s.loadingPanel}`} aria-label="Loading the Assistant" aria-busy="true" />}>
      <DockPanel />
    </Suspense>
  );
}

/**
 * The top bar's Assistant button, and ⌘L / ⌘J (Ctrl elsewhere) — the dock's two doors. On the full-width
 * Assistant it is pressed, and takes the conversation back to the side panel: it never just hides it.
 */
export function DockToggle() {
  const open = useDockOpen();
  const onPage = useOnAssistantPage();
  const back = useBackToDock();
  const toggle = onPage ? back : () => setDockOpen(!open);
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key !== 'l' && e.key !== 'j')) return;
      e.preventDefault();
      latest.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <IconButton
      id={TOGGLE_ID}
      icon="sparkles"
      label="Assistant"
      title={onPage ? 'Assistant: back to the side panel (⌘L)' : "Assistant: works on what you're looking at (⌘L)"}
      aria-expanded={open || onPage}
      aria-controls={onPage ? undefined : 'dock-panel'}
      className={onPage ? s.toggleOn : undefined}
      onClick={toggle}
    />
  );
}

/** How many conversations the title's menu offers before handing over to History. */
const RECENT = 5;

/** The header's active-conversation title; opens the most recent conversations to switch to, and History for the rest. */
export function ThreadMenu({ projectId, threadId, title, onOpen, onAll }: { projectId: string | null; threadId: string; title: string; onOpen: (id: string) => void; onAll: () => void }) {
  const [open, setOpen] = useState(false);
  const threads = useThreads(projectId, open);
  const list = threads.data;
  const note = (label: string): MenuEntry[] => [{ label, disabled: true, onSelect: () => {} }];
  const items: MenuEntry[] = !list
    ? note(threads.isError ? 'Conversations could not load' : 'Loading conversations…')
    : list.length === 0
      ? note('No past conversations yet. Ask something below')
      : [
          ...list.slice(0, RECENT).map(
            (t): MenuEntry => ({
              label: threadTitle(t),
              icon: t.id === threadId ? 'check' : undefined,
              shortcut: turnsLabel(t),
              onSelect: () => onOpen(t.id),
            }),
          ),
          ...(list.length > RECENT ? ([{ kind: 'separator' }, { label: 'All conversations', icon: 'history', onSelect: onAll }] satisfies MenuEntry[]) : []),
        ];
  return (
    <Menu
      label="Conversations"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className={s.threadTitle} aria-label={`Conversations: ${title}`} disabled={!projectId}>
          <span className={s.threadText}>{title}</span>
          <Icon name="chevron-down" />
        </button>
      }
      items={items}
    />
  );
}

/** One conversation as plain text, for the clipboard: who said what, in order. */
export function transcriptText(turns: readonly Turn[]): string {
  return turns.map((t) => `${t.role === 'user' ? 'You' : 'Assistant'}: ${t.text}`).join('\n\n');
}

/**
 * The header's ⋯: what is done to the conversation or the Assistant as a whole.
 * The org's on/off switch and the way to Admin → AI are an admin's, so a member
 * sees neither; the switch waits for a model to be set up (the dock says why).
 */
export function DockMenu({
  status,
  isAdmin,
  turns,
  thread,
  onAct,
}: {
  status: AiStatus | undefined;
  isAdmin: boolean;
  turns: readonly Turn[];
  /** The conversation on screen, once the server has one. */
  thread: ThreadRef | null;
  onAct: (act: ThreadAct) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const on = status?.copilotEnabled !== false;
  const items: MenuEntry[] = [
    { label: 'Rename conversation', icon: 'pencil', disabled: !thread, onSelect: () => thread && onAct({ kind: 'rename', thread }) },
    {
      label: 'Copy conversation',
      icon: 'copy',
      disabled: turns.length === 0,
      onSelect: () => {
        navigator.clipboard.writeText(transcriptText(turns)).then(
          () => toast('Conversation copied.', { kind: 'success' }),
          () => toast('Copy failed. Select the text and copy it instead.', { kind: 'error' }),
        );
      },
    },
    { label: 'Delete conversation', icon: 'trash', danger: true, disabled: !thread, onSelect: () => thread && onAct({ kind: 'delete', thread }) },
  ];
  if (isAdmin) {
    items.push({ kind: 'separator' });
    if (status?.ready) {
      items.push({
        label: on ? 'Turn the Assistant off' : 'Turn the Assistant on',
        icon: 'zap',
        onSelect: () => {
          void setAssistantEnabled(!on).then(
            () => qc.invalidateQueries({ queryKey: ['ai:status'] }),
            () => toast('Could not change the Assistant setting.', { kind: 'error' }),
          );
        },
      });
    }
    items.push({ label: 'AI models', icon: 'settings', onSelect: () => void navigate('/admin?tab=ai') });
  }
  return <Menu label="More" align="end" trigger={<IconButton icon="more-horizontal" size="sm" label="More" />} items={items} />;
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
        className={s.modelQuiet}
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
