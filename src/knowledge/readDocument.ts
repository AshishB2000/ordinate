// Read one uploaded file in a worker thread (./parseWorker), MAIN PROCESS. One worker per parse, never pooled across
// orgs, `resourceLimits` set, 30 seconds, terminated on timeout (it is not a DuckDB worker, so that is allowed).
// Document text is never logged: only the failure code.

import * as path from 'path';
import { Worker } from 'worker_threads';
import { MAX_FILE_BYTES, PARSE_TIMEOUT_MS } from './limits';
import { ParseError, type Parsed, type ReadFailure } from './parseTypes';
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
    default: return msg.unreadable();
  }
}

let workerFile = path.join(__dirname, 'parseWorker.js');
let timeoutMs = PARSE_TIMEOUT_MS;
/** Test hooks. */
export function setWorkerForTest(file: string | null, ms?: number): void {
  workerFile = file ?? path.join(__dirname, 'parseWorker.js');
  timeoutMs = ms ?? PARSE_TIMEOUT_MS;
}

/** The text of `bytes`, or THROWS KnowledgeReadError. */
export async function readDocument(bytes: Uint8Array, fileName = ''): Promise<Parsed> {
  if (bytes.length > MAX_FILE_BYTES) throw new KnowledgeReadError('type', msg.fileTooBig());
  const fail = (code: ReadFailure): KnowledgeReadError => new KnowledgeReadError(code, failureSentence(code));
  const w = new Worker(workerFile, { resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64 } });
  try {
    return await new Promise<Parsed>((resolve, reject) => {
      const timer = setTimeout(() => reject(fail('timeout')), timeoutMs);
      w.once('message', (m: { parsed?: Parsed; code?: ReadFailure }) => {
        clearTimeout(timer);
        if (m.parsed) resolve(m.parsed);
        else reject(fail(m.code ?? 'unreadable'));
      });
      w.once('error', () => { clearTimeout(timer); reject(fail('unreadable')); }); // out of memory included
      w.once('exit', () => { clearTimeout(timer); reject(fail('unreadable')); });
      const copy = new Uint8Array(bytes); // the worker takes this copy
      w.postMessage({ bytes: copy, fileName }, [copy.buffer]);
    });
  } finally {
    void w.terminate();
  }
}

export { ParseError };
