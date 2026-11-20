// Knowledge documents: the parse queue (src/knowledge/readDocument.ts) cannot be used to starve a pod.
//   - the waiting queue holds 8; the next upload is refused AT ONCE with its own sentence (busy)
//   - a waiter whose client hung up (its signal aborted) leaves the queue and never runs
//   - at most ONE running parse per org: org B's upload runs while org A has one running and more waiting
//   - the staged file is read only AFTER the slot is acquired (a waiter holds no bytes)
// NEGATIVE CONTROLS: waiters that stay behave as before (they run, in turn); an org with nothing running starts at once.
//
//   npm run build:ts && node scripts/test-knowledgeQueue.js

export {};
import { ok, finish } from './selfcheck';
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { readDocument, setChildForTest } = require('../src/knowledge/readDocument') as typeof import('../src/knowledge/readDocument');
const msg = require('../src/knowledge/knowledgeMessages') as typeof import('../src/knowledge/knowledgeMessages');
const limits = require('../src/knowledge/limits') as typeof import('../src/knowledge/limits');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-queue-'));
  const log = path.join(dir, 'log');
  const child = path.join(dir, 'child.js');
  // A child that notes it started, takes `hold` ms (a file named gate holds it until it exists), then answers.
  fs.writeFileSync(child, `const fs=require('fs');process.once('message',()=>{fs.appendFileSync(${JSON.stringify(log)},'start\\n');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(dir, 'open'))})){clearInterval(t);process.send({parsed:{source:'text',text:'x'}});setTimeout(()=>process.exit(0),10)}},20)})`);
  setChildForTest(child, 20_000);
  const starts = (): number => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  const loaded: string[] = [];
  const read = (org: string, tag: string, signal?: AbortSignal) => readDocument(async () => { loaded.push(tag); return Buffer.from('x'); }, 'a.txt', { org, signal }).then(() => `ok:${tag}`, (e: Error & { code?: string }) => `${e.code}:${tag}`);

  // A1 and B1 run (one per org); A2, A3 wait behind A1; C1 waits for a free slot.
  const a1 = read('A', 'a1');
  const b1 = read('B', 'b1');
  await sleep(500);
  ok('(setup) two parses run, one per org', starts() === 2 && loaded.join() === 'a1,b1', `${starts()} ${loaded}`);
  const a2 = read('A', 'a2');
  const c1 = read('C', 'c1');
  await sleep(100);
  ok('two more uploads wait (org A already has one running, and C finds no slot), and their files are NOT read yet', starts() === 2 && !loaded.includes('a2') && !loaded.includes('c1'), loaded.join());

  // Fill the queue: 2 are waiting; 6 more fit; the 9th is refused at once.
  const fill = Array.from({ length: limits.PARSE_MAX_WAITING - 2 }, (_, i) => read(`D${i}`, `d${i}`));
  await sleep(50);
  const t0 = Date.now();
  const refused = await read('Z', 'z');
  ok('the queue is full: the next upload is refused AT ONCE with the busy refusal', refused === 'busy:z' && Date.now() - t0 < 200 && !loaded.includes('z'), `${refused} ${Date.now() - t0}ms`);
  ok('…with its own sentence', msg.busy().includes('busy'));

  // A request that is already aborted is refused without queueing.
  const ac = new AbortController();
  ac.abort();
  const abortedNow = await read('Y', 'y', ac.signal);
  ok('a request already aborted is refused without queueing or loading', abortedNow !== 'ok:y' && !loaded.includes('y'), abortedNow);

  // Open the gate: everything left runs in turn.
  fs.writeFileSync(path.join(dir, 'open'), '');
  const all = await Promise.all([a1, b1, a2, c1, ...fill]);
  ok('NEGATIVE CONTROL: the waiters that stayed all ran, in turn, and each loaded its file only then', all.every((r) => r.startsWith('ok:')) && loaded.length === 2 + 2 + fill.length, `${all.join()} ${loaded.length}`);
  fs.rmSync(dir, { recursive: true, force: true });

  // Abort while waiting: a fresh queue.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-queue-'));
  const log2 = path.join(dir2, 'log');
  const child2 = path.join(dir2, 'child.js');
  fs.writeFileSync(child2, `const fs=require('fs');process.once('message',()=>{fs.appendFileSync(${JSON.stringify(log2)},'start\\n');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(dir2, 'open'))})){clearInterval(t);process.send({parsed:{source:'text',text:'x'}});setTimeout(()=>process.exit(0),10)}},20)})`);
  setChildForTest(child2, 20_000);
  const seen: string[] = [];
  const read2 = (org: string, tag: string, signal?: AbortSignal) => readDocument(async () => { seen.push(tag); return Buffer.from('x'); }, 'a.txt', { org, signal }).then(() => `ok:${tag}`, (e: Error & { code?: string }) => `${e.code}:${tag}`);
  const x1 = read2('X', 'x1');
  await sleep(400);
  const ctl = new AbortController();
  const x2 = read2('X', 'x2', ctl.signal); // waits behind x1 (same org)
  await sleep(100);
  ctl.abort(); // the client hung up
  const x2r = await x2;
  ok('an aborted waiter is rejected at once, its file never read', x2r !== 'ok:x2' && !seen.includes('x2'), x2r);
  const x3 = read2('X', 'x3'); // waits behind x1
  fs.writeFileSync(path.join(dir2, 'open'), '');
  const rest = await Promise.all([x1, x3]);
  ok('…and it left the queue: nothing ran for it, the others ran', rest.every((r) => r.startsWith('ok:')) && fs.readFileSync(log2, 'utf8').split('\n').filter(Boolean).length === 2 && !seen.includes('x2'), `${rest} ${seen}`);

  // Two orgs: B runs while A has one running and more waiting.
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-queue-'));
  const log3 = path.join(dir3, 'log');
  const child3 = path.join(dir3, 'child.js');
  fs.writeFileSync(child3, `const fs=require('fs');process.once('message',()=>{fs.appendFileSync(${JSON.stringify(log3)},'start\\n');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(dir3, 'open'))})){clearInterval(t);process.send({parsed:{source:'text',text:'x'}});setTimeout(()=>process.exit(0),10)}},20)})`);
  setChildForTest(child3, 20_000);
  const order: string[] = [];
  const read3 = (org: string, tag: string) => readDocument(async () => { order.push(tag); return Buffer.from('x'); }, 'a.txt', { org }).then(() => `ok:${tag}`);
  const p = [read3('A', 'A1'), read3('A', 'A2'), read3('A', 'A3')];
  await sleep(400);
  const pb = read3('B', 'B1');
  await sleep(400);
  ok('org A has one running, two waiting; org B\'s upload runs at once (one running per org, two slots)', order.join() === 'A1,B1', order.join());
  fs.writeFileSync(path.join(dir3, 'open'), '');
  await Promise.all([...p, pb]);
  ok('NEGATIVE CONTROL: org A\'s waiters run after, one at a time', order.join() === 'A1,B1,A2,A3' || order.join() === 'A1,B1,A3,A2', order.join());
  setChildForTest(null);
  for (const d of [dir2, dir3]) fs.rmSync(d, { recursive: true, force: true });
  finish();
}
main().catch((e) => { console.error(e); process.exitCode = 1; finish(); });
