// Home's hero — homeAsk.ts's ask bar. Enter or the send button hands the
// question to the Assistant dock (still T2.12's placeholder: no model is
// called from Home). The starter chips FILL the bar and focus it; they never
// send — a suggestion is a draft to edit.

import { useRef, useState } from 'react';
import { Icon } from '../../ui/icons/Icon';
import s from './HomePage.module.css';

export function AskBar({ prompts, onAsk }: { prompts: string[]; onAsk: (question: string) => void }) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const submit = () => {
    const text = q.trim();
    if (!text) return;
    setQ('');
    onAsk(text);
  };
  return (
    <div className={s.ask}>
      <form
        className={s.askBar}
        aria-label="Ask the Assistant"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className={s.askIcon} aria-hidden="true">
          <Icon name="sparkles" />
        </span>
        <input
          ref={input}
          className={s.askInput}
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about your data…"
          aria-label="Ask about your data"
          autoComplete="off"
          spellCheck={false}
          maxLength={2000}
        />
        <button className={s.askSend} type="submit" aria-label="Ask" disabled={!q.trim()}>
          <Icon name="arrow-up" />
        </button>
      </form>
      {prompts.length > 0 && (
        <div className={s.chips} aria-label="Suggested questions" role="group">
          {prompts.map((p) => (
            <button
              key={p}
              type="button"
              className={s.chip}
              onClick={() => {
                setQ(p);
                input.current?.focus();
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
