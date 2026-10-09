// The one error a bad setting raises (./env.ts, ./liveEnv.ts). Its own module
// so a settings file split out of env.ts can throw it without importing env.ts
// back (a require cycle). env.ts re-exports it: `env.EnvError` is this class.

/** Thrown for a bad value; `message` is the one line printed at startup. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}
