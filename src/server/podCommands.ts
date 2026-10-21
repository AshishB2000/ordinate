// Commands one pod sends every OTHER pod over the bus (./jobs/bus.ts), for state
// that lives in one process: "cancel job <id> if you hold it", "clear <owner>'s
// finished jobs", "publish <owner>'s jobs to their tabs" (docs/any-pod/00-design.md
// §3.6). Not events for a browser: nothing here reaches a stream.
//
// A command is a name and a small JSON object; each receiver shape-checks its
// own. The sender is installed only while the bus runs (DATABASE_URL): without
// it there is one process, and `toOtherPods` says so by returning false.

type Handler = (data: unknown) => void;

const handlers = new Map<string, Handler>();
let sender: ((cmd: string, data: unknown) => void) | null = null;

/** Registers what this pod does when another pod sends `cmd`. */
export function onPodCommand(cmd: string, fn: Handler): void {
  handlers.set(cmd, fn);
}

/** Installs (or with null removes) the bus's sender. */
export function setPodCommandSender(fn: ((cmd: string, data: unknown) => void) | null): void {
  sender = fn;
}

/** Sends `cmd` to every other pod. False when there are none to tell (no bus). */
export function toOtherPods(cmd: string, data: unknown): boolean {
  if (!sender) return false;
  sender(cmd, data);
  return true;
}

/** A command another pod sent (the bus calls this). An unknown one, or a handler's throw, is ignored. */
export function runPodCommand(cmd: unknown, data: unknown): void {
  const fn = typeof cmd === 'string' ? handlers.get(cmd) : undefined;
  if (!fn) return;
  try {
    fn(data);
  } catch {
    /* a command must not break the bus */
  }
}
