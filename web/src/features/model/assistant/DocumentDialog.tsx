// One knowledge document, open: its title and exactly the text the Assistant reads (docs/knowledge-docs/00-design.md,
// "Screens"). An editor writes or edits it (a typed or pasted one, or the text a file was read as); a reader sees it
// read-only. The server's refusal (empty, too long) stays at its field with the text kept; a save from a stale copy says
// so and offers Reload, never a merge.

import { useState } from 'react';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input, Textarea } from '../../../ui/Field';
import { SkeletonRows } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { SOURCE_LABEL, useDoc, useSaveDoc, type DocFull } from './knowledgeApi';
import k from './Knowledge.module.css';

export const MAX_TEXT = 300_000;
const MAX_TITLE = 120;

function Form({ doc, projectId, agentId, canEdit, onClose, reload }: { doc: DocFull | null; projectId: string; agentId?: string; canEdit: boolean; onClose: () => void; reload: () => void }) {
  const save = useSaveDoc(projectId, agentId);
  const [title, setTitle] = useState(doc?.title ?? '');
  const [text, setText] = useState(doc?.text ?? '');
  const [error, setError] = useState<{ field: 'title' | 'text' | 'form'; message: string; changed?: boolean } | null>(null);
  const long = text.length > MAX_TEXT;
  const dirty = !doc || title !== doc.title || text !== doc.text;

  const submit = async () => {
    setError(null);
    const r = await save.mutateAsync({ ...(doc ? { id: doc.id, base: doc.tag } : {}), title, text });
    if (r.ok) return onClose();
    setError({ field: r.changed ? 'form' : /title/i.test(r.error) ? 'title' : /text|characters|longer/i.test(r.error) ? 'text' : 'form', message: r.error, changed: r.changed });
  };

  const from = doc?.fileName ? `Read from ${doc.fileName}. The original file is not kept; this text is what the Assistant reads, and you can edit it.` : null;
  return (
    <>
      <div className={k.dialogBody}>
        {from && <p className={k.fromFile}>{from}</p>}
        <Input label="Title" value={title} maxLength={MAX_TITLE} readOnly={!canEdit} error={error?.field === 'title' ? error.message : undefined} placeholder="How we count revenue" onChange={(e) => setTitle(e.target.value)} autoFocus={canEdit && !doc} />
        <Textarea
          label={canEdit ? 'Text (Markdown works: # headings help the Assistant find the part it needs)' : 'Text'}
          className={k.textArea}
          rows={16}
          value={text}
          readOnly={!canEdit}
          spellCheck
          error={long ? `${text.length.toLocaleString('en-US')} characters is over the ${MAX_TEXT.toLocaleString('en-US')} limit. Split it into smaller documents.` : error?.field === 'text' ? error.message : undefined}
          hint={`${text.length.toLocaleString('en-US')} / ${MAX_TEXT.toLocaleString('en-US')} characters`}
          onChange={(e) => setText(e.target.value)}
        />
        {error?.field === 'form' && (
          <p className={k.formError} role="alert">
            {error.message}
            {error.changed && (
              <Button size="sm" onClick={reload}>
                Reload
              </Button>
            )}
          </p>
        )}
      </div>
      <div className={k.dialogFoot}>
        <DialogClose asChild>
          <Button>{canEdit ? 'Cancel' : 'Close'}</Button>
        </DialogClose>
        {canEdit && (
          <Button variant="primary" icon="check" loading={save.isPending} disabled={!dirty || long || !title.trim() || !text.trim()} onClick={() => void submit()}>
            {doc ? 'Save' : 'Add document'}
          </Button>
        )}
      </div>
    </>
  );
}

/** `id`: a document's, or 'new'. */
export function DocumentDialog({ projectId, agentId, id, canEdit, onClose }: { projectId: string; agentId?: string; id: string; canEdit: boolean; onClose: () => void }) {
  const q = useDoc(projectId, id === 'new' ? null : id);
  const [gen, setGen] = useState(0);
  const doc = q.data;
  const kind = doc ? SOURCE_LABEL[doc.source] : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={id === 'new' ? 'Add a document' : doc ? doc.title : 'Document'} description={kind ? `${kind} document${canEdit ? '' : ' · read-only'}` : undefined}>
      {id !== 'new' && q.isPending && <div className={k.dialogBody}><SkeletonRows rows={6} label="Loading the document" /></div>}
      {id !== 'new' && q.isError && <ErrorState heading={3} title="The document could not be opened" message={q.error.message || 'It may have been removed.'} onRetry={() => void q.refetch()} />}
      {(id === 'new' || doc) && <Form key={`${doc?.tag ?? 'new'}:${gen}`} doc={doc ?? null} projectId={projectId} agentId={agentId} canEdit={canEdit} onClose={onClose} reload={() => void q.refetch().then(() => setGen((n) => n + 1))} />}
    </Dialog>
  );
}
