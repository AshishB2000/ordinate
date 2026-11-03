// A fake MongoDB server for scripts/test-connectorsMongo: enough of the wire
// protocol for the real driver to connect, list collections, aggregate, page
// with getMore, count and close. The driver opens with a legacy OP_QUERY hello
// (answered with OP_REPLY), then speaks OP_MSG. It never sees sessions: the hello
// reply leaves out logicalSessionTimeoutMinutes.
//
// It does not run pipelines. An aggregate or find answers with the named
// collection's documents, cut by the pipeline's LAST $limit (or find's limit),
// which is the one stage the connector adds and the test checks.

import * as net from 'net';
import { BSON, type Document } from 'mongodb';

const OP_REPLY = 1;
const OP_QUERY = 2004;
const OP_MSG = 2013;

export interface FakeMongoOptions {
  collections: Record<string, Document[]>;
  /** Extra fields for the hello reply (a member list to advertise, say). */
  hello?: Document;
  /** A command this returns true for is never answered. */
  hang?: (cmd: Document) => boolean;
  /** Refuse a SCRAM sign-in. */
  refuseAuth?: boolean;
}

export interface FakeMongo {
  port: number;
  /** Every command received, in order. */
  seen: Document[];
  /** TCP connections accepted, and how many are still open. */
  accepted: number;
  open: number;
  close(): Promise<void>;
}

function frame(requestId: number, responseTo: number, opCode: number, body: Buffer): Buffer {
  const head = Buffer.alloc(16);
  head.writeInt32LE(16 + body.length, 0);
  head.writeInt32LE(requestId, 4);
  head.writeInt32LE(responseTo, 8);
  head.writeInt32LE(opCode, 12);
  return Buffer.concat([head, body]);
}

function opReply(doc: Document): Buffer {
  const fixed = Buffer.alloc(20); // responseFlags, cursorID (int64), startingFrom, numberReturned
  fixed.writeInt32LE(1, 16);
  return Buffer.concat([fixed, BSON.serialize(doc)]);
}

function opMsg(doc: Document): Buffer {
  return Buffer.concat([Buffer.alloc(5), BSON.serialize(doc)]); // flagBits 0, section kind 0
}

/** The command document of an OP_QUERY or OP_MSG body. */
function commandOf(opCode: number, body: Buffer): Document | null {
  if (opCode === OP_QUERY) {
    const nameEnd = body.indexOf(0, 4);
    return BSON.deserialize(body.subarray(nameEnd + 9)); // past the name's NUL, numberToSkip, numberToReturn
  }
  if (opCode === OP_MSG) {
    let at = 4; // flagBits
    let cmd: Document | null = null;
    while (at < body.length) {
      const kind = body[at++];
      const size = body.readInt32LE(at);
      if (kind === 0) cmd = BSON.deserialize(body.subarray(at, at + size));
      at += size;
    }
    return cmd;
  }
  return null;
}

export function startFakeMongo(opts: FakeMongoOptions): Promise<FakeMongo> {
  const sockets = new Set<net.Socket>();
  const cursors = new Map<string, { ns: string; rest: Document[] }>();
  let nextCursor = 1n;
  let nextRequest = 1;
  const state: FakeMongo = {
    port: 0, seen: [], accepted: 0, open: 0,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };

  const batchOf = (ns: string, docs: Document[], size: number, first: boolean): Document => {
    const now = docs.slice(0, size);
    const rest = docs.slice(size);
    let id = BSON.Long.fromNumber(0);
    if (rest.length) {
      const key = String(nextCursor++);
      cursors.set(key, { ns, rest });
      id = BSON.Long.fromString(key);
    }
    return { cursor: { id, ns, [first ? 'firstBatch' : 'nextBatch']: now }, ok: 1 };
  };

  const answer = (cmd: Document): Document => {
    const name = Object.keys(cmd)[0];
    const db = String(cmd.$db ?? 'admin');
    if (name === 'ismaster' || name === 'isMaster' || name === 'hello') {
      return {
        ismaster: true, isWritablePrimary: true, helloOk: true, maxWireVersion: 21, minWireVersion: 0,
        maxBsonObjectSize: 16 * 1024 * 1024, maxMessageSizeBytes: 48_000_000, maxWriteBatchSize: 100_000,
        localTime: new Date(), connectionId: state.accepted, ok: 1, ...opts.hello,
      };
    }
    if (name === 'saslStart' || name === 'saslContinue') {
      return opts.refuseAuth ? { ok: 0, errmsg: 'Authentication failed.', code: 18, codeName: 'AuthenticationFailed' } : { ok: 0, errmsg: 'no auth here', code: 18 };
    }
    if (name === 'listCollections') {
      const all = Object.keys(opts.collections).map((n) => ({ name: n, type: 'collection' }));
      return batchOf(`${db}.$cmd.listCollections`, all, 101, true);
    }
    if (name === 'aggregate' || name === 'find') {
      const coll = String(cmd[name]);
      let docs = opts.collections[coll] ?? [];
      const stages = (name === 'aggregate' ? cmd.pipeline : []) as Document[];
      const limits = stages.filter((st) => '$limit' in st).map((st) => Number(st.$limit));
      const limit = name === 'find' ? Number(cmd.limit ?? 0) : limits.length ? limits[limits.length - 1] : 0;
      if (limit > 0) docs = docs.slice(0, limit);
      const size = Number(name === 'find' ? cmd.batchSize ?? 101 : cmd.cursor?.batchSize ?? 101);
      return batchOf(`${db}.${coll}`, docs, size > 0 ? size : 101, true);
    }
    if (name === 'getMore') {
      const key = String(cmd.getMore);
      const c = cursors.get(key);
      if (!c) return { ok: 0, errmsg: 'cursor not found', code: 43 };
      cursors.delete(key);
      return batchOf(c.ns, c.rest, Number(cmd.batchSize ?? 101), false);
    }
    if (name === 'killCursors') {
      for (const id of (cmd.cursors as unknown[]) ?? []) cursors.delete(String(id));
      return { cursorsKilled: cmd.cursors ?? [], ok: 1 };
    }
    if (name === 'count') return { n: (opts.collections[String(cmd.count)] ?? []).length, ok: 1 };
    if (name === 'endSessions' || name === 'ping') return { ok: 1 };
    return { ok: 0, errmsg: `fake: no such command ${name}`, code: 59 };
  };

  const server = net.createServer((sock) => {
    state.accepted++;
    state.open++;
    sockets.add(sock);
    sock.on('close', () => {
      state.open--;
      sockets.delete(sock);
    });
    sock.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 16 && buf.length >= buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const requestId = buf.readInt32LE(4);
        const opCode = buf.readInt32LE(12);
        const body = buf.subarray(16, len);
        buf = buf.subarray(len);
        const cmd = commandOf(opCode, body);
        if (!cmd) continue;
        state.seen.push(cmd);
        if (opts.hang?.(cmd)) continue;
        const reply = answer(cmd);
        sock.write(opCode === OP_QUERY ? frame(nextRequest++, requestId, OP_REPLY, opReply(reply)) : frame(nextRequest++, requestId, OP_MSG, opMsg(reply)));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as net.AddressInfo).port;
      resolve(state);
    });
  });
}
