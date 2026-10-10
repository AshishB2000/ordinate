// Home's hero — homeAsk.ts's ask bar, as the page's first thing: a tinted
// panel the page's full measure with the bar on it, then the starter questions
// as cards. Enter or the send button hands the question to the Assistant dock
// (no model is called from Home). A starter FILLS the bar and focuses it; it
// never sends — a suggestion is a draft to edit, and asking can cost money.
// Where no model is set up the panel says so, with the one way to fix it.

import { useRef, useState } from 'react';
import { Icon } from '../../ui/icons/Icon';
import { AiNotReady } from '../assistant/AiNotReady';
import { useAiStatus } from '../assistant/api';
import type { Starter } from './homeText';
import s from './HomePage.module.css';

export function AskBar({ prompts, onAsk }: { prompts: Starter[]; onAsk: (question: string) => void }) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const ai = useAiStatus();
  const submit = () => {
    const text = q.trim();
    if (!text) return;
    setQ('');
    onAsk(text);
  };
  return (
    <>
      <section className={s.hero} aria-labelledby="home-ask">
        <h2 id="home-ask" className={s.heroH}>
          <Icon name="sparkles" size={20} />
          Ask your data anything
        </h2>
        <form
          className={s.askBar}
          aria-label="Ask the Assistant"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
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
        {ai.data && !ai.data.ready && <AiNotReady status={ai.data} className={s.heroNote} />}
      </section>
      {prompts.length > 0 && (
        <section className={s.sec} aria-labelledby="home-try">
          <h2 id="home-try" className={s.secH}>
            Try asking
          </h2>
          <div className={s.starters} aria-label="Suggested questions" role="group">
            {prompts.map((p) => (
              <button
                key={p.text}
                type="button"
                className={s.starter}
                onClick={() => {
                  setQ(p.text);
                  input.current?.focus();
                }}
              >
                <span className={s.starterIcon} aria-hidden="true">
                  <Icon name={p.icon} />
                </span>
                <span className={s.starterQ}>{p.text}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
