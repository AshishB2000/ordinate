// Which Assistant answers (docs/assistant-agents/00-design.md, "The composer"): the Project assistant and the agents
// the person may use, in list order, each with what it answers from. Shown only when there is a choice: with no agent
// for this person, nothing on screen changes (rule 1). The list and who may use what are the server's (`agent:list`);
// picking one only says which conversation to start — switching agents starts a new one.

import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { PROJECT_ASSISTANT, type AgentRow } from './agents';
import a from './Agent.module.css';

export const PROJECT_VALUE = '';

export interface AgentPickerProps {
  /** The agents the caller may use (agent:list `usable`). */
  agents: readonly AgentRow[];
  /** The one shown; null: the Project assistant. */
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  /** `bar`: Home's ask bar, a touch larger. */
  size?: 'sm' | 'md';
  className?: string;
}

/** "Finance topic", "All data": what each one answers from, in the open list. */
const from = (agent: AgentRow): string => (agent.topic ? `${agent.topic.name} topic` : 'All data');

export function AgentPicker({ agents, value, onChange, disabled, size = 'sm', className }: AgentPickerProps) {
  if (agents.length === 0) return null;
  const known = value !== null && agents.some((x) => x.id === value) ? value : PROJECT_VALUE;
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
          { value: PROJECT_VALUE, label: PROJECT_ASSISTANT, hint: 'All data' },
          ...agents.map((x) => ({ value: x.id, label: x.name, hint: from(x) })),
        ]}
        onValueChange={(v) => onChange(v === PROJECT_VALUE ? null : v)}
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
