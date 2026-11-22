// The embedded Assistant (docs/embedded-assistant, phase 3): a composer and answers with charts, inside a customer's product. No
// navigation, no sign-in, nothing saved: the conversation lives in this page's memory and goes when the page closes.

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ask, historyOf, type Card, type Turn } from './api';
import { CardTable, MiniChart } from './MiniChart';

const MAX = 1000;

function Answer({ text, card }: { text: string; card: Card | null }) {
  return (
    <div className="answer">
      <p className="prose">{text}</p>
      {card && (
        <section className="card" aria-label={card.title}>
          <h3>{card.title}</h3>
          {card.headline.length > 0 && (
            <ul className="headline">
              {card.headline.map((h) => <li key={h.label}><span>{h.label}</span><strong>{h.display}</strong></li>)}
            </ul>
          )}
          <MiniChart card={card} />
          {card.caption && <p className="caption">{card.caption}</p>}
          {card.bullets.length > 0 && <ul className="bullets">{card.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
          {card.filterLabels.length > 0 && <p className="filters">{card.filterLabels.join(' · ')}</p>}
          {card.notes.length > 0 && <p className="notes">{card.notes.join(' ')}</p>}
          <details><summary>Show as a table</summary><CardTable card={card} /></details>
        </section>
      )}
    </div>
  );
}

export function App({ token, fetcher }: { token: string; fetcher?: typeof fetch }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { document.body.dataset.ready = 'true'; }, []);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [turns, busy]);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q || busy || wait > 0) return;
    const history = historyOf(turns);
    setTurns((t) => [...t, { role: 'user', text: q }]);
    setText('');
    setBusy(true);
    const r = await ask(token, q, history, fetcher);
    setBusy(false);
    if (r.ok) setTurns((t) => [...t, { role: 'assistant', text: r.text, card: r.card }]);
    else {
      setTurns((t) => [...t, { role: 'error', text: r.error, ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}) }]);
      if (r.retryAfter) setWait(r.retryAfter);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) void send();
  };
  return (
    <main className="page">
      <header><h1>Ask about your data</h1></header>
      <div className="log" role="log" aria-live="polite" aria-label="Conversation">
        {turns.length === 0 && (
          <div className="empty">
            <p>Ask a question in your own words and get an answer with a chart.</p>
            <p className="hint">You see only your own data.</p>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? <p key={i} className="me">{t.text}</p>
          : t.role === 'assistant' ? <Answer key={i} text={t.text} card={t.card} />
          : <p key={i} className="problem" role="alert">{t.text}{t.retryAfter ? ` (${t.retryAfter} s)` : ''}</p>,
        )}
        {busy && <p className="busy" role="status">Working on it…</p>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => void send(e)}>
        <label className="sr" htmlFor="q">Your question</label>
        <textarea id="q" rows={2} maxLength={MAX} placeholder="For example: how many shipments were late last month?" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        <button type="submit" disabled={!text.trim() || busy || wait > 0}>{wait > 0 ? `Wait ${wait} s` : 'Ask'}</button>
      </form>
      <footer>Only your own data. Powered by Ordinate.</footer>
    </main>
  );
}
