// The child process one file is read in (./readDocument.ts forks it, with an args array and an empty environment).
//
// WHY A PROCESS, not only a worker thread. A worker's `resourceLimits` cap its V8 heap, but pdf.js's decoded streams are
// ArrayBuffers outside that heap: a 1 MB PDF whose content stream inflates to 1 GB took the main process from 43 MB to
// 2.2 GB through a worker alone (a pod's default limit is 2 GiB). Here the parse still runs in a worker thread, and this
// process's main thread polls its resident memory and exits with EXIT_MEMORY past PARSE_MEMORY_MB, taking the worker
// with it. The parent never holds the bomb: it only sees the exit code. Everything else the worker did stays in force:
// no socket, no eval, the native canvas kept out (./pdf.ts).
//
// Protocol: in { bytes, fileName } -> out { parsed } | { code }, then exit 0. Never imported for its code.

import * as path from 'path';
import { Worker } from 'worker_threads';
import { EXIT_MEMORY, PARSE_MEMORY_MB } from './limits';

const POLL_MS = 25;

if (process.send) {
  const send = (m: unknown): void => { process.send?.(m, () => process.exit(0)); };
  process.on('disconnect', () => process.exit(1)); // the parent is gone: nobody to read for
  process.once('message', (m: { bytes: Uint8Array; fileName: string }) => {
    const worker = new Worker(path.join(__dirname, 'parseWorker.js'), { resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64 } });
    const watch = setInterval(() => {
      if (process.memoryUsage.rss() > PARSE_MEMORY_MB * 1024 * 1024) process.exit(EXIT_MEMORY);
    }, POLL_MS);
    let answered = false;
    worker.once('message', (r: unknown) => { answered = true; clearInterval(watch); send(r); });
    worker.once('error', () => { if (!answered) { answered = true; send({ code: 'unreadable' }); } }); // the worker's own heap limit included
    worker.once('exit', () => { if (!answered) send({ code: 'unreadable' }); });
    worker.postMessage(m);
  });
}
