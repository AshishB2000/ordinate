// A suite's cases (docs/eval-suites/00-design.md, phase 2): each is a question and what a good answer is, as words the editor can read:
// what it should compute (the engine checks that, so no figure is written here), what it should say (a judge scores it), or that the app
// should refuse it. An editor types a case (words or a refusal) and removes one; a figure to compute comes from "Add to tests" on a
// verified question or an answer. At most 100 a suite: the server counts.

import { useState } from 'react';
import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input, Textarea } from '../../ui/Field';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { specWords } from '../model/assistant/specWords';
import { useCases, useEvalCall, type CaseRow } from './api';
import s from './Evals.module.css';

const SOURCE: Record<CaseRow['source'], string> = { verified: 'Verified question', answer: 'An answer', inbox: 'Thumbs-down', typed: 'Typed' };

function Expect({ c }: { c: CaseRow }) {
  return (
    <ul className={s.expects}>
      {c.compute && <li><b>Should compute</b> {specWords(c.compute.spec, c.compute.datasetName)}</li>}
      {c.refuse && <li><b>Should be refused</b></li>}
      {c.say && <li><b>Should say</b> {c.say}</li>}
    </ul>
  );
}

export function SuiteCases({ projectId, suiteId, onClose }: { projectId: string; suiteId: string; onClose: () => void }) {
  const q = useCases(projectId, suiteId);
  const call = useEvalCall(projectId);
  const [question, setQuestion] = useState('');
  const [words, setWords] = useState('');
  const [refuse, setRefuse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const list = q.data?.cases ?? [];
  const full = q.data ? list.length >= q.data.max : false;

  async function add(): Promise<void> {
    setBusy(true);
    setProblem('');
    const r = await call('eval:caseSave', { suiteId, question: question.trim(), ...(words.trim() ? { say: words.trim() } : {}), ...(refuse ? { refuse: true } : {}) });
    setBusy(false);
    if (!r.ok) return setProblem(r.error || 'The test case could not be added.');
    setQuestion('');
    setWords('');
    setRefuse(false);
  }
  async function remove(id: string): Promise<void> {
    const r = await call('eval:caseDelete', { suiteId, id });
    if (!r.ok) setProblem(r.error || 'The test case could not be removed.');
  }

  let body;
  if (q.isPending) body = <SkeletonRows rows={3} label="Loading the test cases" />;
  else if (q.isError) body = <ErrorState compact heading={3} title="The test cases could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (!list.length) {
    body = (
      <EmptyState compact icon="circle-check" heading={3} title="No test cases yet">
        Add a question below, or use “Add to tests” on a verified question or on a good answer, which brings the figure to check.
      </EmptyState>
    );
  } else {
    body = (
      <ul className={s.cases} aria-label="Test cases">
        {list.map((c) => (
          <li key={c.id} className={s.caseRow} data-testid="case-row">
            <div className={s.caseBody}>
              <p className={s.caseQuestion}>{c.question}</p>
              <Expect c={c} />
            </div>
            <Badge>{SOURCE[c.source]}</Badge>
            <IconButton icon="trash" size="sm" label={`Remove “${c.question}”`} onClick={() => void remove(c.id)} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={q.data?.suite.name ?? 'Test cases'}
      description={q.data ? `${list.length} of ${q.data.max} test cases` : undefined}
      footer={<DialogClose asChild><Button variant="primary">Done</Button></DialogClose>}
    >
      <div className={s.caseDialog}>
        {body}
        <form
          className={s.form}
          aria-label="Add a test case"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && question.trim() && (words.trim() || refuse) && !full) void add();
          }}
        >
          <Input label="Question" value={question} maxLength={4000} placeholder="What was revenue last quarter?" onChange={(e) => setQuestion(e.target.value)} />
          <Textarea label="What it should say" rows={2} maxLength={500} value={words} hint="Words for the judge, like “explains that revenue is net of refunds”." onChange={(e) => setWords(e.target.value)} />
          <Checkbox label="It should be refused" hint="The app should refuse this question rather than answer it" checked={refuse} onCheckedChange={setRefuse} />
          {problem && <p className={s.problem} role="alert">{problem}</p>}
          <div>
            <Button type="submit" icon="plus" loading={busy} disabled={full || !question.trim() || (!words.trim() && !refuse)}>
              Add test case
            </Button>
            {full && <span className={s.help}> A suite holds at most {q.data?.max} cases.</span>}
          </div>
        </form>
      </div>
    </Dialog>
  );
}
