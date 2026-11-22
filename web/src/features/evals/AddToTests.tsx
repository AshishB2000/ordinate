// "Add to tests" (docs/eval-suites/00-design.md, phase 2): an editor makes a test case from a verified question (it holds the answer
// spec already), from an answer of their own conversation, or from a question in the thumbs-down inbox. The browser names the source and
// nothing else: the server reads the spec and the question from its own stores, under the editor's folder access. Optional words go to
// the judge; the inbox's question has no spec, so it needs words or "should be refused".

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input, Textarea } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { PROJECT_ASSISTANT } from '../assistant/agents';
import { useAgents } from '../assistant/agents';
import { useCanEdit } from '../projects/api';
import { useEvalCall, useSuites, type Failed } from './api';
import s from './Evals.module.css';

export type Source =
  | { kind: 'verified'; id: string }
  | { kind: 'turn'; threadId: string; turnId: string }
  | { kind: 'inbox'; turnId: string };
const NEW = '__new__';

export function AddToTestsDialog({ projectId, source, agentId, onClose, onAdded }: {
  projectId: string; source: Source;
  /** The assistant a new suite is for; none: the conversation's own (an answer), else the Project assistant. */
  agentId?: string | null;
  onClose: () => void; onAdded?: () => void;
}) {
  const suites = useSuites(projectId);
  const agents = useAgents(projectId);
  const call = useEvalCall(projectId);
  const [choice, setChoice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [words, setWords] = useState('');
  const [refuse, setRefuse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const list = suites.data?.suites ?? [];
  const agentLabel = (id: string | null) => (id ? agents.data?.agents.find((a) => a.id === id)?.name ?? 'An assistant' : PROJECT_ASSISTANT);
  const picked = choice ?? (list.find((x) => x.agentId === (agentId ?? null)) ?? list[0])?.id ?? NEW;
  const inbox = source.kind === 'inbox';
  const missing = inbox && !words.trim() && !refuse;

  async function add(): Promise<void> {
    setBusy(true);
    setProblem('');
    const from = { ...source, ...(words.trim() ? { say: words.trim() } : {}), ...(inbox && refuse ? { refuse: true } : {}) };
    const target = picked === NEW ? { newSuite: { name: name.trim() || 'Tests', ...(agentId !== undefined ? { agentId } : {}) } } : { suiteId: picked };
    const r = await call<{ ok: true; suiteId: string }>('eval:caseFrom', { ...target, from });
    setBusy(false);
    if (!r.ok) return setProblem((r as Failed).error || 'The test could not be added.');
    toast('Added to the tests.', { kind: 'success' });
    onAdded?.();
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Add to tests"
      description={source.kind === 'verified' ? 'The question and the answer’s definition become a test. The app checks the computed figure itself.'
        : source.kind === 'turn' ? 'This answer’s definition becomes what the test expects: the same question, the same figure, computed again each run.'
        : 'Say what a good answer to this question is, so a run can check it.'}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={busy} disabled={suites.isPending || missing} onClick={() => void add()}>
            Add
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <Select
          label="Suite"
          value={picked}
          disabled={suites.isPending}
          placeholder="Loading suites…"
          options={[...list.map((x) => ({ value: x.id, label: `${x.name} · ${agentLabel(x.agentId)}` })), { value: NEW, label: 'A new suite…' }]}
          onValueChange={setChoice}
        />
        {picked === NEW && <Input label="Suite name" value={name} placeholder="Revenue questions" maxLength={80} onChange={(e) => setName(e.target.value)} />}
        <Textarea
          label={inbox ? 'What a good answer says' : 'What it should say (optional)'}
          rows={3}
          maxLength={500}
          value={words}
          hint={inbox ? 'A judge model scores the reply against these words.' : 'Words for the judge, like “explains that revenue is net of refunds”. Figures are checked by the engine, not the judge.'}
          onChange={(e) => setWords(e.target.value)}
        />
        {inbox && <Checkbox label="It should be refused" hint="The app should refuse this question rather than answer it" checked={refuse} onCheckedChange={setRefuse} />}
        {problem && <p className={s.problem} role="alert">{problem}</p>}
      </div>
    </Dialog>
  );
}

/** An editor's button; nothing for a viewer. */
export function AddToTestsButton({ projectId, source, agentId, label = 'Add to tests' }: { projectId: string; source: Source; agentId?: string | null; label?: string }) {
  const canEdit = useCanEdit(projectId);
  const [open, setOpen] = useState(false);
  if (!canEdit) return null;
  return (
    <>
      <Button size="sm" variant="ghost" icon="circle-check" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && <AddToTestsDialog projectId={projectId} source={source} agentId={agentId} onClose={() => setOpen(false)} />}
    </>
  );
}
