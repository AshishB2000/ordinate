// Secrets at rest (T5.3): connection passwords/tokens and AI keys, encrypted in
// Postgres. The desktop keeps its documented plaintext config.json
// (src/app/configSecrets.ts); this is the server's store.
//
// ENVELOPE. Each org has ONE random 32-byte data key (`secret_data_keys`),
// stored wrapped: AES-256-GCM under ORDINATE_MASTER_KEY, AAD = (org, key id).
// Each secret (`secrets`) is AES-256-GCM under its org's data key, fresh 12-byte
// IV, AAD = (org, kind, ref) — so a row copied to another org or another ref,
// or a data key copied to another org, fails its tag check instead of
// decrypting. The master key never touches the database; each wrapped row
// records its `master_kid` (a fingerprint) so a pod on the wrong key fails with
// a message naming both fingerprints, not a bare "bad decrypt".
//
// Rotation re-wraps the data-key rows only (./rotate.ts); payloads are never
// re-encrypted.
//
// No plaintext — secret, data key or master key — ever reaches an error
// message, a log line or a SQL parameter: only ciphertext crosses the pool.

import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes, randomUUID, type KeyObject } from 'crypto';
import type { Pool } from 'pg';

export const SECRET_KINDS = ['connection.password', 'connection.token', 'ai.apiKey'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface SecretStore {
  /** The plaintext, or null when none is stored. Throws `SecretError` if it cannot be decrypted. */
  get(orgId: string, kind: SecretKind, ref: string): Promise<string | null>;
  /** Insert or replace. */
  put(orgId: string, kind: SecretKind, ref: string, value: string): Promise<void>;
  /** True when a row was removed. */
  delete(orgId: string, kind: SecretKind, ref: string): Promise<boolean>;
}

/** Every failure in this layer. The message never carries a secret, a key or a ciphertext. */
export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

// orgId: dev's `default` or a UUID; ref: a connection UUID or a provider name.
// Neither may contain NUL, which keeps the AAD encoding unambiguous.
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_VALUE_BYTES = 64 * 1024;

/** A short public fingerprint of a master key — stored per wrapped row, safe to log. */
export function kidOf(master: KeyObject): string {
  return createHash('sha256').update('ordinate:master-kid:v1\0').update(master.export()).digest('hex').slice(0, 16);
}

export interface Sealed {
  iv: Buffer;
  ct: Buffer;
  tag: Buffer;
}

export function seal(key: KeyObject, plain: Buffer, aad: Buffer): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

/** Throws (a generic crypto error) on any tag mismatch: wrong key, wrong AAD or tampering. */
export function open(key: KeyObject, s: Sealed, aad: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, s.iv);
  d.setAAD(aad);
  d.setAuthTag(s.tag);
  return Buffer.concat([d.update(s.ct), d.final()]);
}

export const dataKeyAad = (orgId: string, keyId: string): Buffer => Buffer.from(`ordinate:data-key:v1\0${orgId}\0${keyId}`);
const secretAad = (orgId: string, kind: string, ref: string): Buffer => Buffer.from(`ordinate:secret:v1\0${orgId}\0${kind}\0${ref}`);

/** A data-key row as stored. */
export interface DataKeyRow {
  id: string;
  org_id: string;
  master_kid: string;
  wrapped: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** The plaintext data key of `row`, which must belong to `orgId`. */
export function unwrapDataKey(master: KeyObject, row: DataKeyRow, orgId: string): KeyObject {
  const kid = kidOf(master);
  if (row.master_kid !== kid) {
    throw new SecretError(
      `data key is wrapped by master key ${row.master_kid} but ORDINATE_MASTER_KEY is ${kid}: finish the rotation or restart with the right key`,
    );
  }
  let raw: Buffer;
  try {
    raw = open(master, { iv: row.iv, ct: row.wrapped, tag: row.tag }, dataKeyAad(orgId, row.id));
  } catch {
    throw new SecretError('data key could not be unwrapped (wrong org, tampered row or wrong master key)');
  }
  const key = createSecretKey(raw);
  raw.fill(0);
  return key;
}

function check(orgId: unknown, kind: unknown, ref: unknown): void {
  if (typeof orgId !== 'string' || !ID_RE.test(orgId)) throw new SecretError('invalid orgId');
  if (!(SECRET_KINDS as readonly unknown[]).includes(kind)) throw new SecretError('invalid secret kind');
  if (typeof ref !== 'string' || !ID_RE.test(ref)) throw new SecretError('invalid ref');
}

const KEY_COLS = 'id, org_id, master_kid, wrapped, iv, tag';

export function createSecretStore(pool: Pool, master: KeyObject): SecretStore {
  const kid = kidOf(master);

  async function orgKey(orgId: string): Promise<{ id: string; key: KeyObject }> {
    const sel = `SELECT ${KEY_COLS} FROM secret_data_keys WHERE org_id = $1`;
    let row = (await pool.query<DataKeyRow>(sel, [orgId])).rows[0];
    if (!row) {
      // Two pods may race to create an org's first key: ON CONFLICT keeps one,
      // and both re-read it.
      const id = randomUUID();
      const raw = randomBytes(32);
      const w = seal(master, raw, dataKeyAad(orgId, id));
      raw.fill(0);
      await pool.query(
        'INSERT INTO secret_data_keys (id, org_id, master_kid, wrapped, iv, tag) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (org_id) DO NOTHING',
        [id, orgId, kid, w.ct, w.iv, w.tag],
      );
      row = (await pool.query<DataKeyRow>(sel, [orgId])).rows[0];
    }
    return { id: row.id, key: unwrapDataKey(master, row, orgId) };
  }

  return {
    async get(orgId, kind, ref) {
      check(orgId, kind, ref);
      const r = await pool.query<DataKeyRow & { s_iv: Buffer; s_ct: Buffer; s_tag: Buffer }>(
        `SELECT k.id, k.org_id, k.master_kid, k.wrapped, k.iv, k.tag, s.iv AS s_iv, s.ciphertext AS s_ct, s.tag AS s_tag
           FROM secrets s JOIN secret_data_keys k ON k.id = s.key_id
          WHERE s.org_id = $1 AND s.kind = $2 AND s.ref = $3`,
        [orgId, kind, ref],
      );
      const row = r.rows[0];
      if (!row) return null;
      // Both AADs use the org the CALLER asked for — not the row's — so a row
      // or key moved between orgs fails here.
      const key = unwrapDataKey(master, row, orgId);
      try {
        return open(key, { iv: row.s_iv, ct: row.s_ct, tag: row.s_tag }, secretAad(orgId, kind, ref)).toString('utf8');
      } catch {
        throw new SecretError('secret could not be decrypted (wrong org or ref, or a tampered row)');
      }
    },

    async put(orgId, kind, ref, value) {
      check(orgId, kind, ref);
      if (typeof value !== 'string' || value === '' || Buffer.byteLength(value) > MAX_VALUE_BYTES) {
        throw new SecretError(`secret value must be a non-empty string of at most ${MAX_VALUE_BYTES} bytes`);
      }
      const { id, key } = await orgKey(orgId);
      const s = seal(key, Buffer.from(value, 'utf8'), secretAad(orgId, kind, ref));
      await pool.query(
        `INSERT INTO secrets (org_id, kind, ref, key_id, ciphertext, iv, tag) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id, kind, ref) DO UPDATE
           SET key_id = EXCLUDED.key_id, ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, updated_at = now()`,
        [orgId, kind, ref, id, s.ct, s.iv, s.tag],
      );
    },

    async delete(orgId, kind, ref) {
      check(orgId, kind, ref);
      const r = await pool.query('DELETE FROM secrets WHERE org_id = $1 AND kind = $2 AND ref = $3', [orgId, kind, ref]);
      return (r.rowCount ?? 0) > 0;
    },
  };
}
