// Read one uploaded file in a child process (./parseChild.ts), MAIN PROCESS. The child, not a worker thread alone, is what
// keeps a hostile file from taking the pod's memory: it is killed past its own budget (PARSE_MEMORY_MB), and past the
// 30 second limit here. At most PARSE_CONCURRENCY run at once per pod; a waiting upload waits, and is refused only
// when it waits past the timeout. One child per parse, never pooled across orgs, forked with an args array (no shell)
// and an empty environment: nothing in its command line comes from a user, a model or a config string.
// Document text is never logged: only the failure code.

import * as path from 'path';
import { fork } from 'child_process';
import { EXIT_MEMORY, MAX_FILE_BYTES, PARSE_CONCURRENCY, PARSE_TIMEOUT_MS } from './limits';
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

// A small in-memory queue: the cap is per pod, which is all the memory budget needs.
let running = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (running < PARSE_CONCURRENCY) { running++; return; }
  await new Promise<void>((resolve, reject) => {
    const turn = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { waiting.splice(waiting.indexOf(turn), 1); reject(fail('timeout')); }, timeoutMs);
    waiting.push(turn);
  });
}
function release(): void {
  const next = waiting.shift();
  if (next) next(); // the slot passes on
  else running--;
}

/** The text of `bytes`, or THROWS KnowledgeReadError. */
export async function readDocument(bytes: Uint8Array, fileName = ''): Promise<Parsed> {
  if (bytes.length > MAX_FILE_BYTES) throw new KnowledgeReadError('type', msg.fileTooBig());
  await acquire();
  try {
    return await run(bytes, fileName);
  } finally {
    release();
  }
}

function run(bytes: Uint8Array, fileName: string): Promise<Parsed> {
  return new Promise<Parsed>((resolve, reject) => {
    const child = fork(childFile, [], { env: {}, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
    let done = false;
    const finish = (f: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      f();
    };
    const timer = setTimeout(() => finish(() => reject(fail('timeout'))), timeoutMs);
    child.once('message', (m: { parsed?: Parsed; code?: ReadFailure }) => finish(() => (m.parsed ? resolve(m.parsed) : reject(fail(m.code ?? 'unreadable')))));
    child.once('error', () => finish(() => reject(fail('unreadable'))));
    child.once('exit', (code) => finish(() => reject(fail(code === EXIT_MEMORY ? 'memory' : 'unreadable'))));
    child.send({ bytes, fileName });
  });
}
