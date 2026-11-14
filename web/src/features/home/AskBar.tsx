// Home's hero — homeAsk.ts's ask bar, as the page's first thing: a tinted
// panel the page's full measure with the bar on it, then small suggestion
// chips under it. It asks what to do, not only what to ask: the Assistant
// builds too. Enter or the send button hands the request to the Assistant's
// full-width page, which asks it (no model is called from Home). A suggestion
// FILLS the bar, tags the dataset it names (the dock's `@`, removable) and
// focuses it; it never sends: a
// suggestion is a draft to edit, and asking can cost money. Suggestions show
// only when a model is set up; where none is, the panel says so, with the one
// way to fix it.

import { useRef, useState } from 'react';
import { Icon } from '../../ui/icons/Icon';
import { AgentPicker } from '../assistant/AgentPicker';
import type { AgentRow } from '../assistant/agents';
import { AiNotReady } from '../assistant/AiNotReady';
import { useAiStatus, useVerifiedChips, type VerifiedChip } from '../assistant/api';
import { VerifiedChips } from '../assistant/VerifiedChips';
import type { Starter } from './homeText';
import s from './HomePage.module.css';

type About = Starter['about'];

/** A suggestion's sentence with the dataset it names drawn as the dock's `@` tag. */
function Sentence({ p }: { p: Starter }) {
  const at = p.text.indexOf(p.about.name);
  if (at < 0) return <>{p.text}</>;
  return (
    <>
      {p.text.slice(0, at)}
      <span className={s.tok}>@{p.about.name}</span>
      {p.text.slice(at + p.about.name.length)}
    </>
  );
}

export interface AskBarProps {
  prompts: Starter[];
  onAsk: (question: string, about?: About) => void;
  projectId?: string;
  onRun?: (c: VerifiedChip) => void;
  /** The Assistant agents this person may use; with none, no picker and nothing changes (docs/assistant-agents rule 1). */
  agents?: readonly AgentRow[];
  /** The one the next question goes to; null: the Project assistant. */
  agentId?: string | null;
  onAgent?: (id: string | null) => void;
}

export function AskBar({ prompts, onAsk, projectId, onRun, agents = [], agentId = null, onAgent }: AskBarProps) {
  const [q, setQ] = useState('');
  const [about, setAbout] = useState<About | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const ai = useAiStatus();
  const all = useVerifiedChips(projectId);
  // An agent's verified answers are its topic's (as in the composer): one outside it is the Project assistant's.
  const topic = agents.find((x) => x.id === agentId)?.topic;
  const verified = topic ? all.filter((v) => topic.datasetIds.includes(v.spec.datasetId)) : all;
  const submit = () => {
    const text = q.trim();
    if (!text) return;
    setQ('');
    setAbout(null);
    onAsk(text, about ?? undefined);
  };
  return (
    <section className={s.hero} aria-labelledby="home-ask">
      <h2 id="home-ask" className={s.heroH}>
        <Icon name="sparkles" size={20} />
        What do you want to do?
      </h2>
      <form
        className={s.askBar}
        aria-label="Ask the Assistant"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {onAgent && (
          <AgentPicker
            agents={agents}
            value={agentId}
            onChange={(id) => {
              onAgent(id);
              input.current?.focus();
            }}
          />
        )}
        {about && (
          <span className={s.askAbout} data-testid="ask-about">
            <span className={s.askAboutName}>@{about.name}</span>
            <button
              type="button"
              className={s.askAboutClear}
              aria-label="Ask about the whole project instead"
              onClick={() => {
                setAbout(null);
                input.current?.focus();
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        )}
        <input
          ref={input}
          className={s.askInput}
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask a question, or say what to build: a chart, a dashboard, a cleaner dataset…"
          aria-label="Ask a question or say what to build"
          autoComplete="off"
          spellCheck={false}
          maxLength={2000}
        />
        <button className={s.askSend} type="submit" aria-label="Ask" disabled={!q.trim()}>
          <Icon name="arrow-up" />
        </button>
      </form>
      {ai.data?.ready && prompts.length > 0 && (
        <div className={s.chips} role="group" aria-label="Suggestions">
          {prompts.map((p) => (
            <button
              key={p.text}
              type="button"
              className={s.chip}
              onClick={() => {
                setQ(p.text);
                setAbout(p.about);
                input.current?.focus();
              }}
            >
              <Icon name={p.icon} size={16} />
              <span className={s.chipText}>
                <Sentence p={p} />
              </span>
            </button>
          ))}
        </div>
      )}
      {onRun && <VerifiedChips className={s.chips} chips={verified} onPick={onRun} />}
      {ai.data && !ai.data.ready && <AiNotReady status={ai.data} className={s.heroNote} />}
    </section>
  );
}
