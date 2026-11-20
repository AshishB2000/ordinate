// The parse worker: one worker_thread per parse (./readDocument), so a hostile file can neither block the event loop
// nor outlive its 30 seconds. Never imported for its code. Protocol: in { bytes, fileName } -> out { parsed } | { code }.

import { parentPort } from 'worker_threads';
import { parseBytes } from './parse';
import { ParseError } from './parseTypes';

const port = parentPort;
if (port) {
  port.once('message', (m: { bytes: Uint8Array; fileName: string }) => {
    parseBytes(m.bytes, m.fileName).then(
      (parsed) => port.postMessage({ parsed }),
      (e: unknown) => port.postMessage({ code: e instanceof ParseError ? e.code : 'unreadable' }),
    );
  });
}
