// "Try a question", the last section of the Data model's Assistant tab (semantic part 3 D11, the owner's answer 2): an
// editor asks as their team would, in their own thread titled "Data model test", and sees beside each answer how it
// was found. The thread is made on the first ask (opening the tab writes nothing) and found again by its title.
// Asking is the dock's: `copilot:ask` with the project context, chips through `answer:rerun`. Figures are the
// engine's, drawn by the same answer card; nothing here computes one.

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { ConfirmDelete } from '../../../ui/ConfirmDelete';
import { Textarea } from '../../../ui/Field';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { ask, deleteThread, newThread, renameThread, useAiStatus, useHistory, useThreads, type Turn } from '../../assistant/api';
import { Transcript, type Pending } from '../../assistant/Transcript';
import { toast } from '../../../ui/Toast';
import { HowAnswered } from './HowAnswered';
import { useVerified } from './api';
import type { TermSummary } from '../terms/api';
import a from './Assistant.module.css';
import t from './TestChat.module.css';

export const TEST_THREAD = 'Data model test';

export function TestChat({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const threads = useThreads(projectId, true);
  const found = threads.data?.find((x) => x.title === TEST_THREAD);
  const tid = found?.id ?? '';
  const history = useHistory(tid ? projectId : null, tid);
  const status = useAiStatus();
  const verified = useVerified(projectId, undefined, { refetchOnMount: false, retryOnMount: false }); // the list above already asked
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [hint, setHint] = useState('');
  const [clearing, setClearing] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const rows = verified.data?.questions ?? [];
  const loaded = !!status.data && !verified.isPending;
  const usable = status.data?.copilotEnabled !== false && (status.data?.ready === true || rows.some((r) => r.runs && r.spec));
  const turns: Turn[] = history.data?.turns ?? [];
  // The glossary, only if the page already holds it: this panel adds no `term:list` call of its own.
  const termRows = qc.getQueryData<TermSummary[]>(['term:list', projectId]);
  const terms = Object.fromEntries((termRows ?? []).map((x) => [x.id, x.name]));

  const put = (next: Turn[], id: string) => {
    qc.setQueryData(['copilot:history', projectId, id], { ok: true, turns: next, threadId: id, title: TEST_THREAD });
    void qc.invalidateQueries({ queryKey: ['copilot:threads', projectId] });
  };
  /** This caller's thread, made and named now if there is none. */
  async function thread(): Promise<string> {
    if (tid) return tid;
    const id = await newThread(projectId);
    if (!id || !(await renameThread(projectId, id, TEST_THREAD))) throw new Error('Could not start the test conversation.');
    return id;
  }

  async function send(): Promise<void> {
    const q = text.trim();
    if (!q || pending) return;
    const askId = crypto.randomUUID();
    setPending({ askId, question: q, text: '', steps: [] });
    setHint('');
    setText('');
    try {
      const id = await thread();
      const r = await ask(projectId, { kind: '' }, q, id, askId);
      if (r.ok) put(r.turns, id);
      else {
        setText(q);
        if (r.notReady) {
          void qc.invalidateQueries({ queryKey: ['ai:status'] });
          setHint('Connect a model to ask anything else.');
        } else setHint(r.error || 'Could not answer that. Try again.');
        void qc.invalidateQueries({ queryKey: ['copilot:threads', projectId] }); // a thread made for an ask that failed
      }
    } catch (e) {
      setText(q);
      setHint(e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.');
    }
    setPending(null);
  }

  async function followUp(spec: Record<string, unknown>, label: string): Promise<void> {
    const r = (await rpc('answer:rerun', { projectId, ...(tid ? { threadId: tid } : {}), spec: spec as { datasetId: string }, label }).catch(() => null)) as
      | { ok: true; turns: Turn[]; threadId: string | null }
      | { ok: false; reason?: string }
      | null;
    if (r && r.ok && r.threadId) put(r.turns, r.threadId);
    else toast((r && !r.ok && r.reason) || 'Could not run that follow-up.', { kind: 'error' });
  }

  async function clear(): Promise<void> {
    if (tid) await deleteThread(projectId, tid).catch(() => false);
    setClearing(false);
    void qc.invalidateQueries({ queryKey: ['copilot:threads', projectId] });
    qc.removeQueries({ queryKey: ['copilot:history', projectId, tid] });
  }

  let body;
  if (threads.isPending || history.isLoading) body = <SkeletonRows rows={3} label="Loading the test conversation" />;
  else if (threads.isError) body = <ErrorState heading={3} title="The test chat could not load" message={threads.error.message || 'Try again.'} onRetry={() => void threads.refetch()} />;
  else if (history.isError) body = <ErrorState heading={3} title="The test conversation could not load" message={history.error.message} onRetry={() => void history.refetch()} />;
  else if (!turns.length && !pending) {
    body = (
      <EmptyState icon="sparkles" heading={3} title="Nothing asked yet">
        Ask the way your team does. Each answer says how it was found, and a good one can be saved as verified.
      </EmptyState>
    );
  } else {
    body = (
      <div className={t.thread}>
        <Transcript
          turns={turns}
          pending={pending}
          lastSteps={null}
          projectId={projectId}
          threadId={tid}
          onFollowUp={followUp}
          aside={(turn) => <HowAnswered turn={turn} verified={rows} terms={terms} />}
        />
      </div>
    );
  }

  return (
    <section className={a.section} aria-labelledby="try-h" data-testid="test-chat">
      <div className={a.head}>
        <div>
          <h2 className={a.title} id="try-h">
            Try a question
          </h2>
          <p className={a.sub}>Ask as your team would, with the instructions and verified questions above. Only you see this conversation.</p>
        </div>
        {turns.length > 0 && (
          <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => setClearing(true)}>
            Clear
          </Button>
        )}
      </div>
      <div className={a.card}>
        <div className={t.stage}>{body}</div>
        {hint && (
          <p className={t.hint} role="alert">
            {hint}
          </p>
        )}
        <form
          className={t.composer}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Textarea
            ref={box}
            aria-label="Question to try"
            className={t.input}
            rows={1}
            value={text}
            disabled={!loaded || !usable || !!pending}
            placeholder="e.g. revenue by region last quarter"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button type="submit" variant="primary" loading={!!pending} disabled={!loaded || !usable || !text.trim()}>
            Ask
          </Button>
        </form>
        {loaded && !usable && <p className={t.note}>Connect a model to try questions.</p>}
      </div>
      {clearing && (
        <ConfirmDelete
          title="Clear the test conversation?"
          description="It is deleted from your conversations too. Verified questions saved from it stay."
          confirm="Clear"
          onConfirm={() => void clear()}
          onClose={() => setClearing(false)}
        />
      )}
    </section>
  );
}
