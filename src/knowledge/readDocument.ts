// Read one uploaded file in a child process (./parseChild.ts), MAIN PROCESS. The child, not a worker thread alone, is what
// keeps a hostile file from taking the pod's memory: it is killed past its own budget (PARSE_MEMORY_MB), and past the
// 30 second limit here. At most PARSE_CONCURRENCY run at once per pod; a waiting upload waits, and is refused only
// when it waits past the timeout. One child per parse, never pooled across orgs, forked with an args array (no shell)
// and an empty environment: nothing in its command line comes from a user, a model or a config string.
// Document text is never logged: only the failure code.

import * as path from 'path';
import { fork } from 'child_process';
import { EXIT_MEMORY, MAX_FILE_BYTES, PARSE_CONCURRENCY, PARSE_MAX_WAITING, PARSE_TIMEOUT_MS } from './limits';
import { type Parsed, type ReadFailure } from './parseTypes';
import * as msg from './knowledgeMessages';

/** A file that could not be read, with the sentence to show. */
export class KnowledgeReadError extends Error {
  constructor(readonly code: ReadFailure, message: string) {
    super(message);
    this.name = 'KnowledgeReadError';
  }
}

export function failureSentence(code: ReadFailure): string {
  switch (code) {
    case 'type': return msg.typeNotAccepted();
    case 'utf8': return msg.notUtf8();
    case 'encrypted': return msg.encrypted();
    case 'noText': return msg.noText();
    case 'zipBomb': return msg.zipBomb();
    case 'tooLong': return msg.tooLong();
    case 'timeout': return msg.timedOut();
    case 'memory': return msg.tooComplex();
    case 'busy': return msg.busy();
    default: return msg.unreadable();
  }
}

let childFile = path.join(__dirname, 'parseChild.js');
let timeoutMs = PARSE_TIMEOUT_MS;
/** Test hook: another child script, and its time limit. */
export function setChildForTest(file: string | null, ms?: number): void {
  childFile = file ?? path.join(__dirname, 'parseChild.js');
  timeoutMs = ms ?? PARSE_TIMEOUT_MS;
}

const fail = (code: ReadFailure): KnowledgeReadError => new KnowledgeReadError(code, failureSentence(code));

// A small in-memory queue, per pod: at most PARSE_CONCURRENCY parses run, at most ONE per org (so one org streaming slow
// files cannot take every slot), and at most PARSE_MAX_WAITING uploads wait: the next is refused at once (busy) instead of
// joining a line it could only time out in. A waiter whose client hung up (its signal) leaves the line. The file's bytes
// are read only once the slot is held (`load`), so a waiter holds none.
interface Waiter { org: string; go: () => void }
let running = 0;
const runningOrgs = new Set<string>();
const waiting: Waiter[] = [];
const canStart = (org: string): boolean => running < PARSE_CONCURRENCY && !runningOrgs.has(org);
const take = (org: string): void => { running++; runningOrgs.add(org); };
function pump(): void {
  for (let i = 0; i < waiting.length && running < PARSE_CONCURRENCY;) {
    if (runningOrgs.has(waiting[i].org)) { i++; continue; }
    const [w] = waiting.splice(i, 1);
    take(w.org);
    w.go();
  }
}
function release(org: string): void {
  running--;
  runningOrgs.delete(org);
  pump();
}
async function acquire(org: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw fail('unreadable');
  if (canStart(org)) { take(org); return; }
  if (waiting.length >= PARSE_MAX_WAITING) throw fail('busy');
  await new Promise<void>((resolve, reject) => {
    const w: Waiter = { org, go: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(); } };
    const leave = (code: ReadFailure): void => { const at = waiting.indexOf(w); if (at >= 0) waiting.splice(at, 1); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(fail(code)); };
    const timer = setTimeout(() => leave('timeout'), timeoutMs);
    const onAbort = (): void => leave('unreadable');
    signal?.addEventListener('abort', onAbort, { once: true });
    waiting.push(w);
  });
}

export interface ReadOptions {
  /** Whose upload this is: one parse runs at a time per org. */
  org?: string;
  /** The request's: aborted when the client hangs up (while waiting or running). */
  signal?: AbortSignal;
}

/**
 * The text of a file, or THROWS KnowledgeReadError. `source`: the bytes, or a loader called only once a slot is held (so a
 * waiting upload holds no file in memory).
 */
export async function readDocument(source: Uint8Array | (() => Promise<Uint8Array>), fileName = '', opts: ReadOptions = {}): Promise<Parsed> {
  const org = opts.org ?? '';
  await acquire(org, opts.signal);
  try {
    const bytes = typeof source === 'function' ? await source() : source;
    if (bytes.length > MAX_FILE_BYTES) throw new KnowledgeReadError('type', msg.fileTooBig());
    return await run(bytes, fileName, opts.signal);
  } finally {
    release(org);
  }
}

function run(bytes: Uint8Array, fileName: string, signal?: AbortSignal): Promise<Parsed> {
  return new Promise<Parsed>((resolve, reject) => {
    const child = fork(childFile, [], { env: {}, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
    let done = false;
    const finish = (f: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.kill('SIGKILL');
      f();
    };
    const timer = setTimeout(() => finish(() => reject(fail('timeout'))), timeoutMs);
    const onAbort = (): void => finish(() => reject(fail('unreadable'))); // the client hung up: stop reading for nobody
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('message', (m: { parsed?: Parsed; code?: ReadFailure }) => finish(() => (m.parsed ? resolve(m.parsed) : reject(fail(m.code ?? 'unreadable')))));
    child.once('error', () => finish(() => reject(fail('unreadable'))));
    child.once('exit', (code) => finish(() => reject(fail(code === EXIT_MEMORY ? 'memory' : 'unreadable'))));
    child.send({ bytes, fileName });
  });
}
