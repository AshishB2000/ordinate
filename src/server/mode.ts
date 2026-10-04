// Is this process the server? Set once by context.enterServerMode. Its own
// dependency-free file so pure modules (user-regex guards, T6.4) can ask
// without importing context.ts, which names electron — the compute worker's
// import graph must never reach that (scripts/test-computeWorker.ts).

let server = false;

export function markServerMode(): void {
  server = true;
}

export function isServerMode(): boolean {
  return server;
}
