// The ONE save queue every whole-document editor writes through
// (docs/edit-conflicts/00-design.md). It holds the record's content tag the
// editor's copy was built on, sends it as `base`, and takes the next one from
// each successful update reply — so a tab never conflicts with itself. A 409
// `record_changed` (another tab or person saved first) sets `changed`: every
// save after it is refused here, unsent, until the editor is reloaded. The
// server's `hub:record-saved` push sets it sooner, when another save moved the
// record's tag.

import { useCallback, useRef, useState } from 'react';
import { RpcError } from '../../api/client';
import { useServerEvent } from '../../api/events';

/** The record types an editor saves whole — the server's `ContentType` (a metric tree is its metric). */
export type GuardType = 'dashboard' | 'visual' | 'metric' | 'report' | 'story' | 'scorecard' | 'scenario';

/** src/app/editConflict.ts SAVED_CHANNEL. */
export const SAVED_CHANNEL = 'hub:record-saved';

export interface EditGuard {
  /** Another writer changed the record under this editor: saves are refused here until it is reloaded. */
  readonly changed: boolean;
  /**
   * One save of the editor's document, after every write queued so far, sent with the current base; the
   * reply's `tag` becomes the next base. Null — and nothing sent — once `changed`; a 409 `record_changed`
   * sets `changed` and resolves null. Any other failure rejects as it would without the guard.
   */
  save<T>(send: (base: string | undefined) => Promise<T>): Promise<T | null>;
  /**
   * Another write to the record in the same queue (a saved-view op). Its reply's `tag` is a CHECK, never
   * adopted: such a write changes no content, so a tag that differs means someone else saved.
   */
  queue<T>(write: () => Promise<T>): Promise<T>;
}

export const isRecordChanged = (err: unknown): boolean => err instanceof RpcError && err.status === 409 && err.code === 'record_changed';

export const tagOf = (reply: unknown): string | undefined => {
  const t = reply && typeof reply === 'object' ? (reply as { tag?: unknown }).tag : undefined;
  return typeof t === 'string' && t ? t : undefined;
};

/** `id` undefined: a record not saved yet — nothing to guard, no base sent. `tag`: from the reply the editor opened with. */
export function useEditGuard(record: { projectId: string; type: GuardType; id: string | undefined }, tag: string | undefined): EditGuard {
  const base = useRef(tag);
  // Every tag this editor's own saves produced: its own push, landing before or after the reply, is not news.
  const own = useRef(new Set(tag ? [tag] : []));
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const stale = useRef(false);
  const [changed, setChanged] = useState(false);

  const flag = useCallback(() => {
    if (stale.current) return;
    stale.current = true;
    setChanged(true);
  }, []);

  const enqueue = useCallback(<T,>(w: () => Promise<T>): Promise<T> => {
    const p = chain.current.then(w);
    chain.current = p.catch(() => undefined);
    return p;
  }, []);

  const save = useCallback(
    <T,>(send: (b: string | undefined) => Promise<T>): Promise<T | null> =>
      enqueue(async () => {
        if (stale.current) return null;
        try {
          const r = await send(base.current);
          const t = tagOf(r);
          if (t) {
            base.current = t;
            own.current.add(t);
          }
          return r;
        } catch (err) {
          if (!isRecordChanged(err)) throw err;
          flag();
          return null;
        }
      }),
    [enqueue, flag],
  );

  const queue = useCallback(
    <T,>(write: () => Promise<T>): Promise<T> =>
      enqueue(async () => {
        const r = await write();
        const t = tagOf(r);
        if (t && base.current && t !== base.current) flag();
        return r;
      }),
    [enqueue, flag],
  );

  const { projectId, type, id } = record;
  useServerEvent(SAVED_CHANNEL, (p) => {
    const s = p && typeof p === 'object' ? (p as { projectId?: unknown; type?: unknown; id?: unknown; tag?: unknown }) : null;
    if (!s || !id || s.projectId !== projectId || s.type !== type || s.id !== id || typeof s.tag !== 'string') return;
    const pushed = s.tag;
    // Checked after this editor's queued saves land, so the push of one still in flight finds its tag in `own`.
    void enqueue(async () => {
      if (pushed !== base.current && !own.current.has(pushed)) flag();
    });
  });

  return { changed, save, queue };
}
