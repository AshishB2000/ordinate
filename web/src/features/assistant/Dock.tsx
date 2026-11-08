// The AI dock — dock.ts, dockHero.ts and dockResize.ts, ported: a docked,
// toggleable panel on the right that follows the user across the app. Its
// context is what is on screen (dockState.ts). This file is its chrome: the
// resizable frame, the header (the conversation's name, full width, new,
// History, ⋯, close) and Esc. The conversation itself, shared with the
// full-width page, is useConversation.ts and Conversation.tsx.

import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '../../ui/Button';
import { Splitter, useStoredSize } from '../../ui/Splitter';
import { ConversationBody, ConversationDialogs } from './Conversation';
import { ASSISTANT_PATH, DockMenu, ThreadMenu, TOGGLE_ID } from './DockParts';
import { forgetPageThread, peekPageThread, setDockOpen } from './dockState';
import { History } from './History';
import { useConversation } from './useConversation';
import s from './Dock.module.css';

const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 340;

/** The open panel — its own lazy chunk (DockParts.tsx `Dock` mounts it), so the shell carries only the toggle. */
export default function DockPanel() {
  const navigate = useNavigate();
  // Back from the full-width page: the conversation it showed. Read on the first render, then forgotten.
  const c = useConversation('dock', peekPageThread());
  useEffect(() => forgetPageThread(), []);
  const [width, setWidth, commitWidth] = useStoredSize('ordinate.dockWidth', DEFAULT_WIDTH, MIN_WIDTH, Math.max(window.innerWidth * 0.4, MIN_WIDTH));

  // Esc closes and hands focus back to the toggle — unless something above (a menu, a select) took it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setDockOpen(false);
      document.getElementById(TOGGLE_ID)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <div className={s.scrim} onClick={() => setDockOpen(false)} aria-hidden="true" />
      <aside id="dock-panel" ref={c.panel} className={s.panel} style={{ width }} tabIndex={-1} aria-label="Assistant">
        {/* Double-click the line: back to the width the dock ships with. */}
        <div
          className={s.handle}
          onDoubleClick={() => {
            setWidth(DEFAULT_WIDTH);
            commitWidth(DEFAULT_WIDTH);
          }}
        >
          <Splitter pane="after" label="Resize the Assistant panel" size={width} min={MIN_WIDTH} max={Math.max(window.innerWidth * 0.4, MIN_WIDTH)} onSizeChange={setWidth} onCommit={commitWidth} />
        </div>
        <div className={s.head}>
          <ThreadMenu projectId={c.pid} threadId={c.shownThread} title={c.title} onOpen={c.switchThread} onAll={() => c.setHistoryOpen(true)} />
          <div className={s.headActions}>
            {/* The same conversation, full width: the dock steps aside while the page shows it. */}
            <IconButton
              icon="maximize"
              size="sm"
              label="Open the Assistant full width"
              onClick={() => {
                setDockOpen(false);
                void navigate(c.shownThread ? `${ASSISTANT_PATH}?thread=${c.shownThread}` : ASSISTANT_PATH);
              }}
            />
            <IconButton icon="plus" size="sm" label="New conversation" disabled={!c.pid || !!c.pending} onClick={() => void c.startNew()} />
            <History projectId={c.pid} threadId={c.shownThread} open={c.historyOpen} onOpenChange={c.setHistoryOpen} onOpen={c.switchThread} onAct={c.setAct} />
            <DockMenu status={c.status.data} isAdmin={c.isAdmin} turns={c.turns} thread={c.shownThread && !c.pending ? { id: c.shownThread, title: c.title } : null} onAct={c.setAct} />
            <IconButton icon="x" size="sm" label="Close the Assistant" onClick={() => setDockOpen(false)} />
          </div>
        </div>
        <ConversationBody c={c} layout="dock" />
      </aside>
      <ConversationDialogs c={c} />
    </>
  );
}
