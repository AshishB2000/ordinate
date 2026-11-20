// "Open in Ordinate" from a Slack answer lands here: /assistant?slack=<question id> (docs/slack/00-design.md). The asker
// opens THEIR conversation; anyone else gets the question asked again, as themselves (their own access decides the
// answer, never the asker's). A question that is gone, or not theirs to open, is said in a toast and the address cleaned.

import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { rpc } from '../../api/client';
import { toast } from '../../ui/Toast';
import { useCurrentProject } from '../projects/current';
import { askOnPage } from './dockState';
import { UUID } from './dockRoute';

type Landing = { ok: true; mine: boolean; projectId: string; threadId: string | null; question: string } | { ok: false; error: string };

export function useSlackLanding(): void {
  const [params, setParams] = useSearchParams();
  const { select } = useCurrentProject();
  const id = params.get('slack') ?? '';
  useEffect(() => {
    if (!UUID.test(id)) return;
    let live = true;
    const done = (next: Record<string, string> = {}) => {
      if (live) setParams(next, { replace: true });
    };
    void rpc('slack:openQuestion', { id }).then(
      (raw) => {
        const r = raw as Landing;
        if (!live) return;
        if (!r.ok) {
          toast(r.error, { kind: 'error' });
          return done();
        }
        select(r.projectId);
        if (r.mine && r.threadId) return done({ thread: r.threadId });
        askOnPage(r.question, { projectId: r.projectId, context: { kind: '', label: 'whole project', name: '' } });
        toast('Asking it again, as you.', { kind: 'success' });
        done();
      },
      (err: unknown) => {
        toast(err instanceof Error ? err.message : 'That Slack question could not be opened.', { kind: 'error' });
        done();
      },
    );
    return () => {
      live = false;
    };
  }, [id, select, setParams]);
}
