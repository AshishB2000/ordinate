// Knowledge documents (docs/knowledge-docs/00-design.md; src/ipc/knowledge.ts over src/knowledge/store.ts): reference
// text an editor attaches to a project or to one Assistant agent, split into passages the Assistant reads when a
// question matches them. Editor prose, never a dataset row (scripts/rowPolicyReaders.ts: META). Postgres only.
//
// Who may read: every reader of the project for the project's documents, everyone who may USE the agent for an agent's
// (rule 3). Who may change: whoever may change the project's instructions, or that agent's (rule 2): `write`.

import { z } from 'zod';
import { Base, byProjectId, FileToken, rpc, Uuid } from './contract';

export const knowledge = {
  // { ok, docs, canEdit, total, max, projectDocs } of the project (no agentId) or of one agent: id, title, source, file
  // name, chars, who and when. Never the text. An agent the caller may not use is refused as gone.
  'knowledge:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, agentId: Uuid.optional() }), project: byProjectId }),
  // One document with its text and the tag `knowledge:save` takes as `base`. A document of an agent the caller may not
  // use, or of another project, is gone.
  'knowledge:get': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // Creates (no `id`: typed or pasted text, for the project or `agentId`) or edits (title and text; a read file's text
  // too). A stale `base` is 409 record_changed. A title or text that is empty or past the caps is refused with a sentence.
  'knowledge:save': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, agentId: Uuid.optional(), id: Uuid.optional(), base: Base.optional(), title: z.string().max(400), text: z.string().max(1_000_000) }),
    project: byProjectId,
  }),
  // Reads the staged upload (a `POST /api/files` token) in a worker thread: PDF, Word (.docx), Markdown or plain text,
  // by its bytes. Stores the text and deletes the staged file. A file that cannot be read is refused with its own sentence.
  'knowledge:upload': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, agentId: Uuid.optional(), fileToken: FileToken, title: z.string().max(400).optional() }),
    project: byProjectId,
  }),
  // The document and its passages.
  'knowledge:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
} as const;
