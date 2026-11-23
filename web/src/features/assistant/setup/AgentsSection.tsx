// The Data model's Assistant tab, first section (docs/assistant-agents/00-design.md, "Data model → Assistant"): the
// Project assistant, always there and the default, then the project's agents in list order — who uses each, what it
// answers from, what it may do. A row opens the agent's page (AgentPage.tsx, `?agent=` in the URL). A project admin
// makes one; an editor opens one to change its instructions; a reader sees the agents they may use.

import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonRows } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { PROJECT_ASSISTANT, useAgents, type AgentRow } from '../../assistant/agents';
import a from './Assistant.module.css';
import g from './Agents.module.css';

/** "Finance, Ops" — or the words for none. */
const teamsOf = (agent: AgentRow): string => (agent.teams.length ? agent.teams.map((t) => t.name).join(', ') : 'No team yet');

/** The agent's first letter, as its mark: no picture, so two agents are told apart by name and tone. */
function Mark({ name, tone }: { name: string; tone: number }) {
  return (
    <span className={`${g.mark} ${g[`tone${tone % 6}`]}`} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '·'}
    </span>
  );
}

function Cell({ icon, text, muted }: { icon: 'user' | 'layers' | 'alert'; text: string; muted?: boolean }) {
  return (
    <span className={muted ? `${g.cell} ${g.cellMuted}` : g.cell}>
      <Icon name={icon} size={12} />
      <span className={g.cellText}>{text}</span>
    </span>
  );
}

/** `onOpen`: an agent's id, or 'new'. */
export function AgentsSection({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const q = useAgents(projectId);
  const list = q.data?.agents ?? [];
  const manage = q.data?.canManage === true;

  let body;
  if (q.isPending) body = <SkeletonRows rows={3} label="Loading the assistants" />;
  else if (q.isError) body = <ErrorState heading={3} title="The assistants could not be loaded" message={q.error.message || 'Try again.'} onRetry={() => void q.refetch()} />;
  else {
    body = (
      <div className={a.card}>
        <ul className={g.list} aria-label="Assistants">
          <li className={g.row} data-testid="agent-row">
            <span className={g.who}>
              <span className={`${g.mark} ${g.markProject}`} aria-hidden="true">
                <Icon name="sparkles" size={16} />
              </span>
              <span className={g.names}>
                <span className={g.name}>{PROJECT_ASSISTANT}</span>
                <span className={g.desc}>Every question, from all the data each person can read</span>
              </span>
            </span>
            <Cell icon="user" text="Everyone" />
            <Cell icon="layers" text="All data" />
            <span className={g.tags}>
              <Badge tone="accent">Default</Badge>
            </span>
            <span className={g.chevronSlot} />
          </li>
          {list.map((x, i) => (
            <li key={x.id} className={g.rowWrap}>
              <button type="button" className={`${g.row} ${g.open}`} data-testid="agent-row" onClick={() => onOpen(x.id)} aria-label={`Open ${x.name}`}>
                <span className={g.who}>
                  <Mark name={x.name} tone={i} />
                  <span className={g.names}>
                    <span className={g.name}>{x.name}</span>
                    <span className={g.desc}>{x.description || (x.topic ? `Answers from the ${x.topic.name} topic` : 'Answers from all data, with its own instructions')}</span>
                  </span>
                </span>
                <Cell icon="user" text={teamsOf(x)} muted={!x.teams.length} />
                {x.topicGone ? <Cell icon="alert" text="Topic deleted · all data" muted /> : <Cell icon="layers" text={x.topic ? `${x.topic.name} topic` : 'All data'} muted={!x.topic} />}
                <span className={g.tags}>
                  {!x.build && <Badge>Answers only</Badge>}
                  {!x.usable && <Badge>Not in your teams</Badge>}
                </span>
                <span className={g.chevronSlot}>
                  <Icon name="chevron-right" size={16} />
                </span>
              </button>
            </li>
          ))}
        </ul>
        {list.length === 0 && (
          <div className={g.empty} data-testid="agents-empty">
            <span className={g.emptyMark} aria-hidden="true">
              <Icon name="plus" size={16} />
            </span>
            <div className={g.emptyText}>
              <p className={g.emptyTitle}>No agents yet</p>
              <p className={g.emptyBody}>
                {manage
                  ? 'Give a team its own assistant: a short list of data, its own instructions and model. People in that team find it picked for them.'
                  : 'A project admin can give a team its own assistant: a short list of data, its own instructions and model.'}
              </p>
            </div>
            {manage && (
              <Button variant="primary" icon="plus" onClick={() => onOpen('new')}>
                New agent
              </Button>
            )}
          </div>
        )}
        <p className={a.foot}>
          <Icon name="info" size={12} />
          An agent only narrows: it never shows anyone data they could not already read. Its instructions come after the project&apos;s and win where they disagree.
        </p>
      </div>
    );
  }

  return (
    <section className={a.section} aria-labelledby="agents-h">
      <div className={a.head}>
        <div>
          <div className={a.titleRow}>
            <h2 className={a.title} id="agents-h">
              Agents
            </h2>
            {list.length > 0 && <Badge>{list.length + 1}</Badge>}
          </div>
          <p className={a.sub}>The Assistant, set up for one team: its own data, instructions and model.</p>
        </div>
        {manage && list.length > 0 && (
          <Button icon="plus" onClick={() => onOpen('new')}>
            New agent
          </Button>
        )}
      </div>
      {body}
    </section>
  );
}
