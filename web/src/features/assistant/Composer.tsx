// The Assistant's composer: what the answer will be about (a chip), the
// question, and one row of controls under it — which model answers, `@` to
// point at something else, a way to bring data in, send. The text and the
// asking are useConversation's; this is their surface. Full width (`page`) the
// chip IS the `@` and sits in that row, and the model is named in the page's
// header instead.

import { useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import type { AiStatus } from './api';
import { CONTEXT_ICON, ContextPicker } from './ContextPicker';
import { ModelPicker } from './DockParts';
import type { DockContext } from './dockState';
import s from './Dock.module.css';
import w from './Wide.module.css';

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
  layout?: 'dock' | 'page';
  className?: string;
}

export function Composer({ inputRef, projectId, status, context, pinned, onPin, text, onText, onSend, usable, placeholder, projectPick, layout = 'dock', className }: ComposerProps) {
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

  const about = context.kind ? context.name || `open ${context.kind}` : 'whole project';
  const picker = (trigger?: ReactElement) => <ContextPicker projectId={projectId} open={picking} onOpenChange={setPicking} onPick={onPin} onClosed={backToInput} trigger={trigger} />;
  const clear = pinned && (
    <button type="button" className={s.contextClear} aria-label="Follow what’s on screen again" onClick={() => onPin(null)}>
      <Icon name="x" />
    </button>
  );
  const wide = layout === 'page';
  return (
    <div className={[s.composer, wide && w.composer, className].filter(Boolean).join(' ')}>
      {!wide && (
        <div className={s.context}>
          <span className={s.contextLabel}>Based on</span>
          <span className={pinned ? `${s.contextChip} ${s.contextPinned}` : s.contextChip} title={`Answers are based on ${context.label}`} data-testid="dock-context">
            <Icon name={CONTEXT_ICON[context.kind] ?? 'folder'} />
            <span className={s.contextName}>{about}</span>
            {clear}
          </span>
          {projectPick && <span className={s.projectPick}>{projectPick}</span>}
        </div>
      )}
      <textarea
        ref={inputRef}
        className={wide ? `${s.input} ${w.input}` : s.input}
        rows={1}
        aria-label="Ask the Assistant"
        placeholder={placeholder}
        disabled={!usable}
        value={text}
        onChange={onChange}
        onKeyDown={onKey}
      />
      <div className={s.composeFoot}>
        {wide ? (
          <>
            {picker(
              <button type="button" className={pinned ? `${w.at} ${w.atPinned}` : w.at} disabled={!projectId} aria-label={`Based on ${about}. Point the Assistant at something else`} title={`Answers are based on ${context.label}`} data-testid="dock-context">
                <span className={w.atName}>{`@ ${about.charAt(0).toUpperCase()}${about.slice(1)}`}</span>
                <Icon name="chevron-down" size={12} />
              </button>,
            )}
            {clear}
            {projectPick && <span className={w.projectPick}>{projectPick}</span>}
          </>
        ) : (
          <ModelPicker status={status} />
        )}
        <div className={s.composeActions}>
          {!wide && picker()}
          <AddData projectId={projectId} />
          <IconButton icon="arrow-up" size="sm" variant="primary" label="Send" className={wide ? w.send : undefined} disabled={!usable || !text.trim()} onClick={onSend} />
        </div>
      </div>
    </div>
  );
}
