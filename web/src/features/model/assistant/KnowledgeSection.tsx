// The Documents section (docs/knowledge-docs/00-design.md, "Screens"), on Model → Assistant (the project's documents) and on
// an agent's page (that agent's own): the list (title, kind, size, who edited and when), Add document and Upload PDF or
// Word, a document view showing exactly the text the Assistant reads, editing, a delete behind the house confirm, and an
// empty state that says what documents are for and points short rules to Instructions. The upload says what it is doing
// (reading) and the server's sentence when it refuses a file. Who may read and change is the server's.

import { useRef, useState } from 'react';
import { Badge } from '../../../ui/Badge';
import { Button, IconButton } from '../../../ui/Button';
import { ConfirmDelete } from '../../../ui/ConfirmDelete';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { dayInYear } from '../../data/format';
import { DocumentDialog } from './DocumentDialog';
import { DocsOff, SOURCE_LABEL, useDeleteDoc, useDocs, useUploadDoc, type DocRow } from './knowledgeApi';
import a from './Assistant.module.css';
import k from './Knowledge.module.css';

const ACCEPT = '.pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain';
const ICON = { typed: 'pencil', markdown: 'file-text', text: 'file-text', pdf: 'file-text', docx: 'file-text' } as const;
const chars = (n: number) => `${n.toLocaleString('en-US')} characters`;

function Row({ doc, canEdit, onOpen, onRemove }: { doc: DocRow; canEdit: boolean; onOpen: () => void; onRemove: () => void }) {
  const when = Number.isNaN(Date.parse(doc.updatedAt)) ? '' : dayInYear.format(new Date(doc.updatedAt));
  return (
    <li className={k.row} data-testid="document-row">
      <span className={k.mark} aria-hidden="true">
        <Icon name={ICON[doc.source]} size={16} />
      </span>
      <button type="button" className={k.open} onClick={onOpen} aria-label={`${canEdit ? 'Edit' : 'Read'} ${doc.title}`}>
        <span className={k.docTitle}>{doc.title}</span>
        <span className={k.docMeta}>
          <Badge>{SOURCE_LABEL[doc.source]}</Badge>
          <span>{chars(doc.chars)}</span>
          {doc.fileName && <span className={k.fileName}>{doc.fileName}</span>}
        </span>
      </button>
      <span className={k.who}>{[doc.updatedBy, when].filter(Boolean).join(' · ')}</span>
      {canEdit && (
        <span className={k.actions}>
          <IconButton icon="trash" size="sm" label={`Remove ${doc.title}`} onClick={onRemove} />
        </span>
      )}
    </li>
  );
}

/** `agentId`: the agent whose own documents these are; none for the project's. `canEdit`: may change them (an editor). */
export function KnowledgeSection({ projectId, agentId, canEdit }: { projectId: string; agentId?: string; canEdit: boolean }) {
  const q = useDocs(projectId, agentId);
  const upload = useUploadDoc(projectId, agentId);
  const del = useDeleteDoc(projectId);
  const picker = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DocRow | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ name: string; message: string } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const list = q.data?.docs ?? [];
  const editable = canEdit && (q.data?.canEdit ?? true);
  const full = q.data ? q.data.total >= q.data.max : false;

  const chosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setRefused(null);
    setReading(file.name);
    void upload.mutateAsync(file).then((message) => {
      setReading(null);
      if (message) setRefused({ name: file.name, message });
    });
  };
  const remove = async () => {
    if (!removing) return;
    const message = await del.mutateAsync(removing.id);
    setRemoveError(message);
    setRemoving(null);
  };

  const buttons = editable && (
    <div className={k.buttons}>
      <Button icon="upload" loading={reading !== null} disabled={full} onClick={() => picker.current?.click()}>
        Upload PDF or Word
      </Button>
      <Button variant="primary" icon="plus" disabled={full || reading !== null} onClick={() => setOpen('new')}>
        Add document
      </Button>
      <input ref={picker} type="file" accept={ACCEPT} aria-label="Document file" hidden onChange={chosen} />
    </div>
  );

  let body;
  if (q.isPending) body = <SkeletonRows rows={3} label="Loading the documents" />;
  else if (q.error instanceof DocsOff) {
    body = (
      <EmptyState icon="database" heading={3} title="Documents need a database">
        This server runs without Postgres, where documents are off. Set DATABASE_URL to use them.
      </EmptyState>
    );
  } else if (q.isError) body = <ErrorState heading={3} title="The documents could not be loaded" message={q.error.message || 'Try again.'} onRetry={() => void q.refetch()} />;
  else if (!list.length && reading === null) {
    body = (
      <EmptyState
        icon="file-text"
        heading={3}
        title={agentId ? 'No documents of its own yet' : 'No documents yet'}
        actions={editable && (
          <>
            <Button icon="upload" onClick={() => picker.current?.click()}>
              Upload PDF or Word
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setOpen('new')}>
              Add document
            </Button>
          </>
        )}
      >
        {editable
          ? 'Attach what explains your business: how you count revenue, the fiscal calendar, what an active customer is. The Assistant reads the parts that match a question. Short rules, one line each, belong in Instructions instead.'
          : 'Documents that explain the business, like how revenue is counted, go here. An editor of this project can add them.'}
      </EmptyState>
    );
  } else {
    body = (
      <div className={a.card}>
        <ul className={k.list} aria-label="Documents">
          {reading !== null && (
            <li className={`${k.row} ${k.reading}`} role="status">
              <span className={k.mark} aria-hidden="true">
                <span className={k.spinner} />
              </span>
              <span className={k.docTitle}>{`Reading ${reading}…`}</span>
            </li>
          )}
          {list.map((d) => (
            <Row key={d.id} doc={d} canEdit={editable} onOpen={() => setOpen(d.id)} onRemove={() => setRemoving(d)} />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <section className={a.section} aria-labelledby={`documents-${agentId ?? 'project'}-h`}>
      <div className={a.head}>
        <div>
          <div className={a.titleRow}>
            <h2 className={a.title} id={`documents-${agentId ?? 'project'}-h`}>
              Documents
            </h2>
            {!!list.length && <Badge>{list.length}</Badge>}
          </div>
          <p className={a.sub}>{agentId ? 'Reference text only this assistant reads, on top of the project’s documents.' : 'Reference text the Assistant reads when a question matches it: PDF, Word, Markdown or plain text.'}</p>
        </div>
        {buttons}
      </div>
      {refused && (
        <div className={k.refused} role="alert">
          <Icon name="alert" size={16} />
          <span>
            <strong>{refused.name}</strong> was not added. {refused.message}
          </span>
          <IconButton icon="x" size="sm" label="Dismiss" onClick={() => setRefused(null)} />
        </div>
      )}
      {removeError && (
        <p className={a.error} role="alert">
          {removeError}
        </p>
      )}
      {body}
      {!q.isPending && !q.isError && (
        <p className={k.foot}>
          <Icon name="info" size={12} />
          <span>
            Anyone who can ask this assistant can see what these documents say, including in Slack channels connected to it.
            {agentId && q.data?.projectDocs ? ` The project’s ${q.data.projectDocs} document${q.data.projectDocs === 1 ? '' : 's'} apply to this assistant too.` : ''}
            {full ? ` A project can hold ${q.data?.max} documents, and this one is full.` : ''}
          </span>
        </p>
      )}
      {open && <DocumentDialog projectId={projectId} agentId={agentId} id={open} canEdit={editable} onClose={() => setOpen(null)} />}
      {removing && (
        <ConfirmDelete
          title={`Remove “${removing.title}”?`}
          description="The Assistant stops reading it, for everyone. Nothing brings it back: the original file is not kept."
          confirm="Remove"
          busy={del.isPending}
          onConfirm={() => void remove()}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
