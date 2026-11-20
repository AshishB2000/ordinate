// The worker idles while no Slack workspace is switched on (./worker.ts); anything that may start work on this pod wakes it.

let wakeAt = 0;
let listeners: Array<() => void> = [];

/** The next poll looks at the queue at once. */
export function wake(): void {
  wakeAt = Date.now();
  for (const f of listeners) f();
}
export const lastWake = (): number => wakeAt;
export function onWake(f: () => void): () => void {
  listeners.push(f);
  return () => { listeners = listeners.filter((x) => x !== f); };
}
