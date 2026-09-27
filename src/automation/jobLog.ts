// userData/automation-log.jsonl — how a job that ran in a HEADLESS process
// (`--cli`, `--mcp` over stdio) reaches the GUI's Jobs popover.
//
// The headless process appends each finished job as one JSON line
// (headless.ts); the GUI tails the file (src/ipc/automation.ts) and hands each
// new line to `jobs.recordExternal`, which shape-checks it like the jobs file.
// Pure fs, so the round trip is tested without Electron.
//
// ponytail: append-only, ~300 bytes a job, never rotated — the GUI starts
// reading at the END of the file, so its size never costs a boot. Rotate if a
// machine ever runs automation in the hundreds of thousands of jobs.

import * as fs from 'fs';

export const LOG_NAME = 'automation-log.jsonl';

/** One O_APPEND write per job, so concurrent headless runs never interleave a line. */
export function appendJob(file: string, job: unknown): void {
  try {
    fs.appendFileSync(file, JSON.stringify(job) + '\n', 'utf8');
  } catch (_) {
    /* the log is a courtesy to the Jobs popover; the job itself already ran */
  }
}

export function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
}

/**
 * Complete lines added since `offset`, and the offset after the last one. A
 * half-written tail (no newline yet) is left for the next read. A file that
 * shrank was replaced: read it from the start.
 */
export function readNewLines(file: string, offset: number): { offset: number; lines: string[] } {
  const size = sizeOf(file);
  const from = size < offset ? 0 : offset;
  if (size === from) return { offset: from, lines: [] };
  let buf: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return { offset: from, lines: [] };
  }
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { offset: from, lines: [] };
  const lines = buf.subarray(0, end).toString('utf8').split('\n').filter((l) => l.trim());
  return { offset: from + end + 1, lines };
}
