// A fake Snowflake SQL API for the self-checks — no network. It records every
// request the connector sends and answers from scripts/fixtures/snowflake/*.json
// (shapes recorded from the SQL API's documented responses: rowType and
// partitionInfo metadata, every value a string, the 202 QueryStatus, the 422
// QueryFailureStatus). Installed with snowflake.setTransport(fake.transport).
//
// Like the real transport (src/connectors/snowflakeHttp.ts), a request whose
// `signal` fires while its answer is pending fails with SfAbortError.

import * as fs from 'fs';
import * as path from 'path';
import { SfAbortError, type SfHttpRequest, type SfHttpResponse } from '../src/connectors/snowflakeHttp';

export const HANDLE = '01b0e8a5-0002-3c8a-0000-0001234a5b6e';

/** A recorded response body, by file name (no extension). */
export function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'snowflake', `${name}.json`), 'utf8');
}

export const reply = (status: number, body: string, truncated = false): SfHttpResponse => ({ status, body, truncated });

/** What a request is, by its method and path. */
export type Kind = 'submit' | 'status' | 'partition' | 'cancel';

export interface Seen {
  kind: Kind;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  /** The submit body, parsed. */
  json: Record<string, unknown> | null;
}

export function kindOf(req: SfHttpRequest): Kind {
  if (req.method === 'POST') return req.url.pathname.endsWith('/cancel') ? 'cancel' : 'submit';
  return req.url.searchParams.has('partition') ? 'partition' : 'status';
}

/** A promise and its settlers, for an answer the test releases later. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export class FakeSnowflake {
  seen: Seen[] = [];
  /** The answer to each request; the default is the all-types result, then a cancel ack. */
  answer: (req: SfHttpRequest, kind: Kind) => SfHttpResponse | Promise<SfHttpResponse> = (_req, kind) =>
    kind === 'cancel' ? reply(200, fixture('cancel-200')) : reply(200, fixture('result-types'));

  readonly transport = async (req: SfHttpRequest): Promise<SfHttpResponse> => {
    const kind = kindOf(req);
    let json: Record<string, unknown> | null = null;
    if (kind === 'submit' && req.body) json = JSON.parse(req.body) as Record<string, unknown>;
    this.seen.push({ kind, method: req.method, url: req.url, headers: { ...req.headers }, body: req.body ?? '', json });
    const answer = Promise.resolve(this.answer(req, kind));
    const signal = req.signal;
    if (!signal) return answer;
    if (signal.aborted) throw new SfAbortError('cancelled', req.timeoutMs);
    return new Promise<SfHttpResponse>((resolve, rejectAnswer) => {
      const onAbort = (): void => rejectAnswer(new SfAbortError('cancelled', req.timeoutMs));
      signal.addEventListener('abort', onAbort, { once: true });
      answer.then(
        (r) => { signal.removeEventListener('abort', onAbort); resolve(r); },
        (e: unknown) => { signal.removeEventListener('abort', onAbort); rejectAnswer(e); },
      );
    });
  };

  of(kind: Kind): Seen[] {
    return this.seen.filter((s) => s.kind === kind);
  }

  /** The submitted statements, in order. */
  statements(): string[] {
    return this.of('submit').map((s) => String(s.json?.statement ?? ''));
  }
}

/** Wait until `cond` holds (a background cancel landing), or give up after `ms`. */
export async function until(cond: () => boolean, ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}
