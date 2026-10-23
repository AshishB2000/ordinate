// The server's log for notifications — a member's alert inbox (./alertInbox.ts)
// and mention notices (./mentions/notify.ts) — injected by src/server/app.ts, as
// subscriptions/deliver.ts takes `useDeliveryLog`. Silent until wired.

export interface NotifyLog {
  warn(obj: object, msg: string): void;
}

let log: NotifyLog = { warn: () => undefined };

/** The server's logger (src/server/app.ts). */
export function useNotifyLog(l: NotifyLog): void {
  log = l;
}

export function notifyLog(): NotifyLog {
  return log;
}

/** An error's message for a log line — never the error object (it can carry a query or a connection string). */
export const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));
