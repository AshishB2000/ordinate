// The bell's "Definition proposals" (docs/metric-proposals/00-design.md; src/server/proposals): for an editor, a proposed
// metric or term waiting for a decision, which opens the Proposals tab; for the people who asked, the outcome: approved
// (with "Ask again", which hands the same question back to the Assistant) or declined with the editor's note. Unseen first.
// Routes are built here from ids; `useProposalNotice` is the toast in the open tabs of whoever a proposal concerns.

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useServerEvent } from '../../api/events';
import { rpc } from '../../api/client';
import { ago } from '../../app/when';
import { Button } from '../../ui/Button';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { openDockWith } from '../assistant/dockState';
import { ME_KEY } from '../auth/api';
import { useOverview } from '../projects/api';
import { MENTIONS_KEY, useMentionSeen, type ProposalRow } from './mentionsApi';
import a from './Alerts.module.css';
import s from './Mentions.module.css';

export const proposalsPath = (projectId: string): string => `/model/${projectId}?tab=proposals`;

function lineOf(r: ProposalRow): { head: string; sub: string } {
  const what = r.kind === 'term' ? 'term' : 'metric';
  if (r.mine) {
    if (r.state === 'approved') return { head: `“${r.name}” is now defined`, sub: r.decidedBy ? `Approved by ${r.decidedBy}. Ask your question again.` : 'Approved. Ask your question again.' };
    return { head: `Your proposed ${what} “${r.name}” was declined`, sub: r.decidedBy ? `Declined by ${r.decidedBy}` : 'Declined' };
  }
  const sub = r.state === 'open' ? (r.asks === 1 ? 'Needed once' : `Needed ${r.asks} times`) : r.state === 'approved' ? `Approved by ${r.decidedBy}` : `Declined by ${r.decidedBy}`;
  return { head: `A ${what} was proposed: ${r.name}`, sub };
}

export function ProposalsForYou({ items, onOpened }: { items: readonly ProposalRow[]; onOpened: () => void }) {
  const seen = useMentionSeen();
  const projects = useOverview();
  const navigate = useNavigate();
  return (
    <section aria-labelledby="bell-proposals">
      <h3 id="bell-proposals" className={a.inboxSec}>
        Definition proposals
      </h3>
      <ul className={s.rows}>
        {items.map((r) => {
          const where = projects.data?.find((p) => p.id === r.projectId)?.name;
          const line = lineOf(r);
          const canAsk = r.mine && r.state === 'approved' && r.question !== '';
          const open = () => {
            if (!r.seen) seen.mutate({ projectId: r.projectId, id: r.id });
            if (r.mine) return;
            onOpened();
            void navigate(proposalsPath(r.projectId));
          };
          return (
            <li key={`${r.projectId}:${r.id}`}>
              <button type="button" className={r.seen ? s.row : `${s.row} ${s.rowNew}`} aria-label={`${line.head}${r.seen ? '' : ', new'}. ${line.sub}`} onClick={open} data-testid="bell-proposal">
                <span className={s.rowTop}>
                  {!r.seen && <span className={s.dot} aria-hidden="true" />}
                  <span className={s.rowBy}>{line.head}</span>
                  <span className={s.rowWhen}>{ago(r.at)}</span>
                </span>
                {r.mine && r.question && <span className={s.snippet}>{r.question}</span>}
                {r.mine && r.state === 'declined' && r.answer && <span className={s.askNote}>{r.answer}</span>}
                <span className={s.on}>
                  <Icon name="sparkles" size={12} />
                  <span className={s.onName}>
                    {line.sub}
                    {where ? ` · ${where}` : ''}
                  </span>
                </span>
              </button>
              {canAsk && (
                <div className={s.rowAct}>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="sparkles"
                    aria-label={`Ask again: ${r.question}`}
                    onClick={() => {
                      if (!r.seen) seen.mutate({ projectId: r.projectId, id: r.id });
                      onOpened();
                      openDockWith(r.question, { projectId: r.projectId, context: { kind: '', label: 'whole project', name: '' } });
                    }}
                  >
                    Ask again
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one app-wide listener for `proposals:changed` (ids, names of people and project, the state; never a definition), mounted by the bell. */
export function useProposalNotice(): void {
  const navigate = useNavigate();
  const client = useQueryClient();
  useServerEvent('proposals:changed', (p) => {
    const n = (p ?? {}) as Record<string, unknown>;
    const projectId = str(n.projectId);
    const id = str(n.id);
    if (!UUID.test(projectId) || !UUID.test(id)) return;
    void client.invalidateQueries({ queryKey: MENTIONS_KEY });
    void client.invalidateQueries({ queryKey: ME_KEY }); // the badge's count rides on /api/auth/me
    const by = str(n.by) || 'Someone';
    const on = str(n.on) || 'a project';
    const state = str(n.state);
    if (state === 'open') {
      const go = () => {
        void rpc('mentions:seen', { projectId, id }).then(() => {
          void client.invalidateQueries({ queryKey: MENTIONS_KEY });
          void client.invalidateQueries({ queryKey: ME_KEY });
        });
        void navigate(proposalsPath(projectId));
      };
      toast(`${by} proposed a definition in ${on}`, { action: { label: 'Review', onClick: go } });
    } else if (state === 'approved') toast(`${by} approved a definition you asked for in ${on}. The bell has it: ask again.`);
    else if (state === 'declined') toast(`${by} declined a definition you asked for in ${on}. The bell has their note.`);
  });
}
