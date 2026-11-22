// Which Assistant answers (docs/assistant-agents/00-design.md, "The composer"): the Project assistant and the agents
// the person may use, in list order, each with what it answers from. Shown only when there is a choice: with no agent
// for this person, nothing on screen changes (rule 1). The list and who may use what are the server's (`agent:list`);
// picking one only says which conversation to start — switching agents starts a new one.

import { useState } from 'react';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { PROJECT_ASSISTANT, type AgentRow } from './agents';
import a from './Agent.module.css';

export const PROJECT_VALUE = '';
const AUTO_VALUE = '__auto';

export interface AgentPickerProps {
  /** The agents the caller may use (agent:list `usable`). */
  agents: readonly AgentRow[];
  /** The one shown; null: the Project assistant. */
  value: string | null;
  onChange: (id: string | null) => void;
  /** Auto (docs/agent-router): the router picks from the question. Offered when this person may use two or more agents, with `onAuto`. */
  auto?: boolean;
  onAuto?: () => void;
  disabled?: boolean;
  /** `bar`: Home's ask bar, a touch larger. */
  size?: 'sm' | 'md';
  className?: string;
}

/** "Finance topic", "All data": what each one answers from, in the open list. */
const from = (agent: AgentRow): string => (agent.topic ? `${agent.topic.name} topic` : 'All data');

export function AgentPicker({ agents, value, onChange, auto = false, onAuto, disabled, size = 'sm', className }: AgentPickerProps) {
  if (agents.length === 0) return null;
  const withAuto = !!onAuto && agents.length >= 2;
  const known = withAuto && auto ? AUTO_VALUE : value !== null && agents.some((x) => x.id === value) ? value : PROJECT_VALUE;
  return (
    <span className={[a.pick, known !== PROJECT_VALUE && a.picked, className].filter(Boolean).join(' ')} data-testid="agent-picker">
      <Icon name="sparkles" size={12} />
      <Select
        size={size}
        className={a.select}
        aria-label="Assistant"
        value={known}
        disabled={disabled}
        options={[
          ...(withAuto ? [{ value: AUTO_VALUE, label: 'Auto', hint: 'Picks the agent from your question' }] : []),
          { value: PROJECT_VALUE, label: PROJECT_ASSISTANT, hint: 'All data' },
          ...agents.map((x) => ({ value: x.id, label: x.name, hint: from(x) })),
        ]}
        onValueChange={(v) => (v === AUTO_VALUE ? onAuto?.() : onChange(v === PROJECT_VALUE ? null : v))}
      />
    </span>
  );
}

/**
 * An agent's out-of-scope reply (rule 10): the app's two lines, and one click that asks the Project assistant the same
 * question in a new conversation. The dataset it names is one the server found among what this person can read.
 */
export function OutsideCard({ agent, text, onAsk, busy }: { agent: string; text: string; onAsk?: () => void; busy?: boolean }) {
  const [head, ...rest] = text.split('\n');
  return (
    <div className={a.outside} data-testid="agent-outside">
      <div className={a.outsideHead}>
        <span className={a.outsideMark} aria-hidden="true">
          <Icon name="layers" size={12} />
        </span>
        <span className={a.outsideAgent}>{agent}</span>
      </div>
      <p className={a.outsideLine}>{head}</p>
      {rest.length > 0 && <p className={a.outsideOffer}>{rest.join(' ')}</p>}
      {onAsk && (
        <button type="button" className={a.outsideAsk} disabled={busy} onClick={onAsk}>
          <Icon name="sparkles" size={12} />
          Ask the Project assistant
          <Icon name="arrow-right" size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * Auto could not tell two or three agents apart for a question: nothing was asked, so the person picks (docs/agent-router, Q2).
 * A click asks the same question with that agent, in a conversation with it.
 */
export function AgentChoices({ question, options, busy, onPick, onDismiss }: { question: string; options: readonly { id: string; name: string; description?: string }[]; busy?: boolean; onPick: (id: string) => void; onDismiss: () => void }) {
  return (
    <div className={a.choose} role="group" aria-label="Which assistant should answer?" data-testid="agent-choices">
      <p className={a.chooseLine}>
        {`“${question.length > 80 ? `${question.slice(0, 80)}…` : question}” fits more than one assistant. Which should answer?`}
      </p>
      <div className={a.chooseRow}>
        {options.map((o) => (
          <button key={o.id} type="button" className={a.chooseBtn} disabled={busy} title={o.description} onClick={() => onPick(o.id)}>
            <Icon name="sparkles" size={12} />
            {o.name}
          </button>
        ))}
        <button type="button" className={a.chooseNo} onClick={onDismiss}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** "Answered by Finance agent · Change", and the reason Auto gave. Change asks the same question with another agent, in a new conversation. */
export function RoutedLine({ agent, why, others, busy, onChange }: { agent: string; why: string; others: readonly { id: string; name: string }[]; busy?: boolean; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={a.routed} data-testid="routed-line">
      <span className={a.routedBy}>{`Answered by ${agent}`}</span>
      {others.length > 0 && (
        <>
          <span aria-hidden="true"> · </span>
          <button type="button" className={a.routedChange} aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
            Change
          </button>
        </>
      )}
      <span className={a.routedWhy}>{why}</span>
      {open && (
        <span className={a.routedList} role="group" aria-label="Ask another assistant">
          {others.map((o) => (
            <button key={o.id} type="button" className={a.chooseBtn} disabled={busy} onClick={() => { setOpen(false); onChange(o.id); }}>
              {o.name}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
