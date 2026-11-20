// Knowledge documents at rest (0042_knowledge.sql, docs/knowledge-docs/00-design.md "Storage"). MAIN PROCESS. Postgres
// only: without DATABASE_URL (`knowledgeOn()` false) the feature is off, as Slack and the secrets are.
//
// Every statement runs in `inOrg` (forced row-level security, `ordinate.org`) and names its org and project besides.
// A save rewrites the document's passages in the SAME transaction as its row. Document text is never logged.

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { inOrg, orgDb } from '../server/db/inOrg';
import { searchWords } from '../ai/modelWords';
import { MAX_DOCS_PER_PROJECT, MAX_TEXT_CHARS, MAX_TITLE } from './limits';
import { passageWords, type RankPassage } from './rank';
import { splitText } from './split';
import type { DocSource } from './parseTypes';
import * as msg from './knowledgeMessages';

export const knowledgeOn = (): boolean => orgDb() !== null;

export interface DocMeta {
  id: string;
  projectId: string;
  /** The Assistant agent it belongs to; null for a project document. */
  agentId: string | null;
  title: string;
  source: DocSource;
  fileName: string | null;
  chars: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}
export interface Doc extends DocMeta {
  text: string;
  /** What `base` of the next save must be: an edit from a stale copy is refused. */
  tag: string;
}

/** A refusal with its sentence (the editor's to read), never a throw. */
export class KnowledgeRefusal extends Error {
  constructor(readonly code: 'title' | 'text' | 'tooLong' | 'full' | 'gone', message: string) {
    super(message);
    this.name = 'KnowledgeRefusal';
  }
}

const COLS = `id::text, project_id::text AS "projectId", agent_id::text AS "agentId", title, source, file_name AS "fileName", chars,
  created_by AS "createdBy", to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt", updated_by AS "updatedBy", to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"`;

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The edit tag: the stored document's identity at its last edit. Computed, never stored. */
const tagOf = (updatedAt: string, textHash: string, title: string): string => createHash('sha256').update(`${updatedAt}\n${textHash}\n${title}`).digest('base64url');

/** A title as stored: one line, at most MAX_TITLE; THROWS the refusal. */
export function cleanTitle(raw: string): string {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) throw new KnowledgeRefusal('title', msg.titleMissing());
  if (title.length > MAX_TITLE) throw new KnowledgeRefusal('title', msg.titleTooLong(MAX_TITLE));
  return title;
}
/** A text as stored: LF newlines, no NUL; THROWS the refusal (empty, or past the cap: never cut silently). */
export function cleanText(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  if (!text.trim()) throw new KnowledgeRefusal('text', msg.textMissing());
  if (text.length > MAX_TEXT_CHARS) throw new KnowledgeRefusal('tooLong', msg.tooLong());
  return text;
}

/** The passages of `text`, as rows: written by the caller inside the document's own transaction. */
async function writePassages(c: PoolClient, org: string, projectId: string, id: string, agentId: string | null, title: string, text: string): Promise<number> {
  await c.query('DELETE FROM knowledge_passages WHERE org_id = $1 AND doc_id = $2', [org, id]);
  const rows = splitText(text).map((p) => ({ ...p, ...passageWords(title, p.heading, p.text) }));
  if (!rows.length) return 0;
  const join = (f: (r: (typeof rows)[number]) => string[]): string[] => rows.map((r) => f(r).join(' ')); // a word holds no space (searchWords)
  await c.query(
    `INSERT INTO knowledge_passages (org_id, project_id, doc_id, agent_id, ord, heading, text, title_words, heading_words, text_words, words)
     SELECT $1, $2, $3, $4, u.ord, u.heading, u.text, string_to_array(u.tw, ' '), string_to_array(u.hw, ' '), string_to_array(u.xw, ' '), string_to_array(u.w, ' ')
     FROM unnest($5::int[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[]) AS u(ord, heading, text, tw, hw, xw, w)`,
    [org, projectId, id, agentId, rows.map((r) => r.ord), rows.map((r) => r.heading), rows.map((r) => r.text), join((r) => r.titleWords), join((r) => r.headingWords), join((r) => r.textWords), join((r) => r.words)],
  );
  return rows.length;
}

async function lockProject(c: PoolClient, org: string, projectId: string): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`knowledge:${org}:${projectId}`]);
}

/** The documents of the project (no agent) or of one agent, newest edit first. Never the text. */
export async function listDocs(projectId: string, agentId: string | null): Promise<DocMeta[]> {
  return inOrg(async (c, org) => (await c.query<DocMeta>(
    `SELECT ${COLS} FROM knowledge_docs WHERE org_id = $1 AND project_id = $2 AND agent_id IS NOT DISTINCT FROM $3::uuid ORDER BY updated_at DESC, id`, [org, projectId, agentId])).rows);
}

/** How many documents the project holds, its agents' too (a trashed agent's included: they come back with it). */
export async function countDocs(projectId: string): Promise<number> {
  return inOrg(async (c, org) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM knowledge_docs WHERE org_id = $1 AND project_id = $2', [org, projectId])).rows[0].n));
}

/** One document with its text, or null. The project is part of the key: an id from another project finds nothing. */
export async function getDoc(projectId: string, id: string): Promise<Doc | null> {
  return inOrg(async (c, org) => {
    const r = await c.query<DocMeta & { text: string; textHash: string }>(`SELECT ${COLS}, text, text_hash AS "textHash" FROM knowledge_docs WHERE org_id = $1 AND project_id = $2 AND id = $3`, [org, projectId, id]);
    const d = r.rows[0];
    if (!d) return null;
    const { textHash, ...rest } = d;
    return { ...rest, tag: tagOf(rest.updatedAt, textHash, rest.title) };
  });
}

export interface Input { title: string; text: string; source?: DocSource; fileName?: string | null }

/** A new document, with its passages, in one transaction. THROWS KnowledgeRefusal (title, text, past the caps, the project full). */
export async function createDoc(projectId: string, agentId: string | null, input: Input, id: string, by: string): Promise<Doc> {
  const title = cleanTitle(input.title);
  const text = cleanText(input.text);
  await inOrg(async (c, org) => {
    await lockProject(c, org, projectId);
    const n = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM knowledge_docs WHERE org_id = $1 AND project_id = $2', [org, projectId])).rows[0].n);
    if (n >= MAX_DOCS_PER_PROJECT) throw new KnowledgeRefusal('full', msg.projectFull(MAX_DOCS_PER_PROJECT));
    await c.query(
      `INSERT INTO knowledge_docs (org_id, project_id, id, agent_id, title, source, file_name, chars, text, text_hash, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [org, projectId, id, agentId, title, input.source ?? 'typed', input.fileName ?? null, text.length, text, hashOf(text), by]);
    await writePassages(c, org, projectId, id, agentId, title, text);
  });
  const doc = await getDoc(projectId, id);
  if (!doc) throw new KnowledgeRefusal('gone', msg.docGone());
  return doc;
}

/**
 * An edit of title and text. A `base` that is not the stored tag is refused untouched (ERECORDCHANGED: the RPC route
 * answers 409 record_changed, as every edit conflict); without one the save is last-writer-wins. Null when gone.
 */
export async function updateDoc(projectId: string, id: string, input: Input, base: string | undefined, by: string): Promise<Doc | null> {
  const title = cleanTitle(input.title);
  const text = cleanText(input.text);
  const done = await inOrg(async (c, org) => {
    const cur = await c.query<{ agentId: string | null; updatedAt: string; textHash: string; title: string }>(
      `SELECT agent_id::text AS "agentId", to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt", text_hash AS "textHash", title FROM knowledge_docs WHERE org_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`, [org, projectId, id]);
    const d = cur.rows[0];
    if (!d) return false;
    const tag = tagOf(d.updatedAt, d.textHash, d.title);
    if (base !== undefined && base !== tag) throw Object.assign(new Error(msg.docChanged()), { code: 'ERECORDCHANGED', tag });
    await c.query('UPDATE knowledge_docs SET title = $4, chars = $5, text = $6, text_hash = $7, updated_by = $8, updated_at = clock_timestamp() WHERE org_id = $1 AND project_id = $2 AND id = $3',
      [org, projectId, id, title, text.length, text, hashOf(text), by]);
    await writePassages(c, org, projectId, id, d.agentId, title, text);
    return true;
  });
  return done ? getDoc(projectId, id) : null;
}

/** Delete one document; its passages go with it (ON DELETE CASCADE). False when it was not there. */
export async function deleteDoc(projectId: string, id: string): Promise<boolean> {
  return inOrg(async (c, org) => !!(await c.query('DELETE FROM knowledge_docs WHERE org_id = $1 AND project_id = $2 AND id = $3', [org, projectId, id])).rowCount);
}

/** The titles of documents by id (a document gone is absent), for the answer's "How this was answered". */
export async function titlesOf(projectId: string, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length || !knowledgeOn()) return new Map();
  return inOrg(async (c, org) => new Map((await c.query<{ id: string; title: string }>(
    'SELECT id::text, title FROM knowledge_docs WHERE org_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])', [org, projectId, ids])).rows.map((r) => [r.id, r.title])));
}

/** Passages ranked and read at most this many: a common word must not read a whole project's passages on every ask. */
const NARROW_LIMIT = 5000;

/**
 * The stored passages that share a word with `question`, for the project's documents and the answering agent's: the
 * candidates the pure ranking (./rank.ts) orders. `words && $1` is only a narrowing: a passage with no word in common
 * scores 0 there, so ranking these equals ranking every passage (scripts/test-knowledgeRank.ts holds the two equal).
 * shortcut: capped at NARROW_LIMIT rows (by doc id, ord); past it a very common word could hide a better passage. Lift
 * it with a SQL pre-score if a project ever holds that many matching passages.
 */
export async function candidates(projectId: string, agentId: string | null, question: string): Promise<RankPassage[]> {
  const words = searchWords(question).slice(0, 64);
  if (!words.length) return [];
  return inOrg(async (c, org) => (await c.query<RankPassage & { own: boolean }>(
    `SELECT p.doc_id::text AS "docId", p.ord, (p.agent_id IS NOT NULL) AS own, to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt", d.title, p.heading, p.text,
       p.title_words AS "titleWords", p.heading_words AS "headingWords", p.text_words AS "textWords"
     FROM knowledge_passages p JOIN knowledge_docs d ON d.org_id = p.org_id AND d.id = p.doc_id
     WHERE p.org_id = $1 AND p.project_id = $2 AND (p.agent_id IS NULL OR p.agent_id = $3::uuid) AND p.words && $4::text[]
     ORDER BY p.doc_id, p.ord LIMIT ${NARROW_LIMIT}`, [org, projectId, agentId, words])).rows);
}

/** Every passage of the project's documents and the agent's (the reference the narrowed ranking is held equal to). */
export async function allPassages(projectId: string, agentId: string | null): Promise<RankPassage[]> {
  return inOrg(async (c, org) => (await c.query<RankPassage>(
    `SELECT p.doc_id::text AS "docId", p.ord, (p.agent_id IS NOT NULL) AS own, to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt", d.title, p.heading, p.text,
       p.title_words AS "titleWords", p.heading_words AS "headingWords", p.text_words AS "textWords"
     FROM knowledge_passages p JOIN knowledge_docs d ON d.org_id = p.org_id AND d.id = p.doc_id
     WHERE p.org_id = $1 AND p.project_id = $2 AND (p.agent_id IS NULL OR p.agent_id = $3::uuid) ORDER BY p.doc_id, p.ord`, [org, projectId, agentId])).rows);
}
