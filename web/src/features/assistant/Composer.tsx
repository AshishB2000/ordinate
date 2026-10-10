// The dock's composer: what the answer will be about (a chip), the question,
// and one row of controls under it — which model answers, `@` to point at
// something else, a way to bring data in, send. The text and the asking are
// Dock.tsx's; this is their surface.

import { useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import type { AiStatus } from './api';
import { CONTEXT_ICON, ContextPicker } from './ContextPicker';
import { ModelPicker } from './DockParts';
import type { DockContext } from './dockState';
import s from './Dock.module.css';

/** Bring data in — the import page's own doors, in the dock's project. Nothing is sent to a model from here. */
function AddData({ projectId }: { projectId: string | null }) {
  const navigate = useNavigate();
  const go = (to: string) => () => void navigate(to);
  const importAt = (source: string) => `/data/import?project=${projectId}&source=${source}`;
  return (
    <Menu
      label="Add data"
      side="top"
      align="end"
      trigger={<IconButton icon="paperclip" size="sm" label="Add data" disabled={!projectId} />}
      items={[
        { label: 'Import a file', icon: 'upload', onSelect: go(importAt('file')) },
        { label: 'Paste a table', icon: 'clipboard', onSelect: go(importAt('paste')) },
        { label: 'Read a screenshot', icon: 'camera', onSelect: go(importAt('screenshot')) },
        { kind: 'separator' },
        { label: 'Connect a source', icon: 'plug', onSelect: go(`/connections/${projectId}`) },
      ]}
    />
  );
}

export interface ComposerProps {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  projectId: string | null;
  status: AiStatus | undefined;
  /** What the next answer is based on: the pinned reference, else what is on screen. */
  context: DockContext;
  pinned: boolean;
  onPin: (c: DockContext | null) => void;
  text: string;
  onText: (text: string) => void;
  onSend: () => void;
  /** A question can be asked now (a project, a model, nothing pending). */
  usable: boolean;
  placeholder: string;
  /** The project switch, when the URL does not decide the project. */
  projectPick?: ReactNode;
}

export function Composer({ inputRef, projectId, status, context, pinned, onPin, text, onText, onSend, usable, placeholder, projectPick }: ComposerProps) {
  const [picking, setPicking] = useState(false);
  const caret = useRef<number | null>(null); // where the `@` was typed, to return to

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  // One `@` typed where a word starts opens the picker and is not kept; inside a
  // word (an email address) it is just a character. Read off the CHANGE, not a
  // keydown: an IME or an on-screen keyboard inserts text without one.
  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    const at = e.target.selectionStart;
    if (projectId && next.length === text.length + 1 && next[at - 1] === '@' && (at === 1 || /\s/.test(next[at - 2]))) {
      caret.current = at - 1;
      setPicking(true);
      return; // `text` stands, so React puts the field back without the `@`
    }
    onText(next);
  };

  const backToInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (caret.current !== null) el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  };

  return (
    <div className={s.composer}>
      <div className={s.context}>
        <span className={s.contextLabel}>Based on</span>
        <span className={pinned ? `${s.contextChip} ${s.contextPinned}` : s.contextChip} title={`Answers are based on ${context.label}`} data-testid="dock-context">
          <Icon name={CONTEXT_ICON[context.kind] ?? 'folder'} />
          <span className={s.contextName}>{context.kind ? context.name || `open ${context.kind}` : 'whole project'}</span>
          {pinned && (
            <button type="button" className={s.contextClear} aria-label="Follow what’s on screen again" onClick={() => onPin(null)}>
              <Icon name="x" />
            </button>
          )}
        </span>
        {projectPick && <span className={s.projectPick}>{projectPick}</span>}
      </div>
      <textarea
        ref={inputRef}
        className={s.input}
        rows={1}
        aria-label="Ask the Assistant"
        placeholder={placeholder}
        disabled={!usable}
        value={text}
        onChange={onChange}
        onKeyDown={onKey}
      />
      <div className={s.composeFoot}>
        <ModelPicker status={status} />
        <div className={s.composeActions}>
          <ContextPicker projectId={projectId} open={picking} onOpenChange={setPicking} onPick={onPin} onClosed={backToInput} />
          <AddData projectId={projectId} />
          <IconButton icon="arrow-up" size="sm" variant="primary" label="Send" disabled={!usable || !text.trim()} onClick={onSend} />
        </div>
      </div>
    </div>
  );
}
