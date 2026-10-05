// The server's stand-in for the desktop app's `ipcMain`: a registry that STORES the
// handlers every src/ipc/*.ts registers, so `POST /api/rpc/:channel` can call
// them. Only the three members the handler files use exist (`handle`, `on`,
// `removeHandler`); src/ipc/bus.ts hands this out.
//
// Storing a handler does not expose it: the route also needs a contract in
// src/api/ (no contract → 404). `on` listeners are kept but no route reaches
// them yet — the 11 fire-and-forget channels are all desktop chrome.

// any: a handler's arguments are untrusted payloads; the route types them
// through the channel's zod contract before the call.
export type Handler = (event: unknown, ...args: any[]) => unknown;

const handlerMap = new Map<string, Handler>();
const listeners = new Map<string, Handler[]>();

export const registry = {
  handle(channel: string, fn: Handler): void {
    // A second handler throws, or two modules could
    // silently fight over one channel and the last require would win.
    if (handlerMap.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    handlerMap.set(channel, fn);
  },
  removeHandler(channel: string): void {
    handlerMap.delete(channel);
  },
  on(channel: string, fn: Handler): void {
    listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
  },
};

/** Every stored handler by channel — what the route calls, and what test scripts invoke directly. */
export const handlers: ReadonlyMap<string, Handler> = handlerMap;
