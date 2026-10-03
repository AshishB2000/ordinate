// Toast — hub.ts showToast(), ported: a bottom-right STACK of at most three
// cards (a fourth pushes the oldest out), each gone after 4 s, with an
// optional action ("Retry", "Undo"). `toast()` is a plain function so a
// mutation's onError can call it from outside React, as ~120 legacy call
// sites called showToast.
//
// The stack is ALWAYS in the document with role="status" (a live region must
// exist before text lands in it, or nothing is announced); <Toaster/> mounts
// once, in the shell.
//
// ponytail: timers do not pause on hover or focus — parity with the desktop;
// add pause-on-hover if a toast ever carries more than one line to read.

import { useSyncExternalStore } from 'react';
import { Icon, type IconName } from './icons/Icon';
import s from './Toast.module.css';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  action?: { label: string; onClick: () => void };
}

const MAX = 3;
const TTL_MS = 4000;
const ICON: Record<ToastKind, IconName> = { info: 'info', success: 'check', error: 'alert' };

let items: readonly ToastItem[] = [];
let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const next = items.filter((t) => t.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

/** Show a message. Text only — it is set as text, never parsed as markup. */
export function toast(message: string, opts: { kind?: ToastKind; action?: ToastItem['action'] } = {}): number {
  const id = ++seq;
  items = [...items, { id, message, kind: opts.kind ?? 'info', action: opts.action }];
  while (items.length > MAX) dismissToast(items[0].id);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), TTL_MS),
  );
  emit();
  return id;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => items;

export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div className={s.stack} role="status" aria-live="polite" aria-label="Notifications">
      {list.map((t) => (
        <div key={t.id} className={`${s.toast} ${s[t.kind]}`}>
          <Icon name={ICON[t.kind]} />
          <span className={s.text}>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className={s.action}
              onClick={() => {
                dismissToast(t.id);
                t.action?.onClick();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
