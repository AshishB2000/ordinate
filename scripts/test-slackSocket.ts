// Ordinate in Slack, phase 3: Socket Mode (docs/slack/00-design.md). A pod takes one of ten lease rows, asks Slack for a
// socket with the app-level token, connects with the built-in WebSocket, acknowledges each envelope by its envelope_id once
// the event is queued, and reconnects when Slack says disconnect. Pods without a slot still answer. Against a local stub
// (its own RFC 6455 server) over a scratch Postgres; skips without DATABASE_URL.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-slackSocket.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { slackWorld, sleep, until, APP_TOKEN } from './slackHarness';

const store: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const socketMod: typeof import('../src/server/slack/socket') = require('../src/server/slack/socket');
const workerMod: typeof import('../src/server/slack/worker') = require('../src/server/slack/worker');

(async () => {
  const S = await slackWorld('slack socket');
  if (!S) return;
  const { W, stub } = S;
  const TEAM = stub.team.id;
  const quiet = { error: () => undefined, warn: () => undefined };
  socketMod.tuneSocketForTest({ tickMs: 3_600_000, leaseMs: 800, backoffMs: 50 });
  const podA = (workerMod.latestForTest() as import('../src/server/slack/worker').SlackWorker).sockets;
  try {
    await S.link('boss');
    // Events mode: no socket is opened.
    await podA.tick();
    await sleep(300);
    ok('Mode: in Events mode no pod opens a socket', stub.callsOf('apps.connections.open').length === 0 && stub.sockets.size === 0);

    // Switch to Socket Mode (the app-level token was saved with the install).
    const sw = await W.call('boss', 'slack:settings', { mode: 'socket' });
    ok('Mode: the admin switches to Socket Mode through the setup page\'s channel', sw.body.ok === true && sw.body.install.mode === 'socket', sw.text);
    await podA.tick();
    ok('Socket: the pod takes a slot, opens a connection with the app-level token and connects', await until(async () => stub.sockets.size === 1, 5000)
      && stub.callsOf('apps.connections.open').at(-1)?.token === APP_TOKEN);
    ok('Socket: it holds slot 1 of this install', (await W.pool.query(`SELECT slot FROM slack_socket_slots WHERE team_id = $1`, [TEAM])).rows.map((r) => r.slot).join() === '1');

    // An event over the socket is queued, acknowledged by envelope_id, and answered.
    S.answer = { text: 'Socket answer 42.', datasets: [W.plain] };
    const ev = S.dm('boss', 'over the socket?', { id: 'EvSock1' });
    stub.push({ type: 'events_api', envelope_id: 'env-1', payload: ev, accepts_response_payload: false });
    ok('Socket: the envelope is acknowledged by its envelope_id', await until(async () => stub.acks.some((a) => a.envelope_id === 'env-1'), 5000));
    ok('Socket: the event became a question and was answered', await until(async () => /Socket answer 42/.test(JSON.stringify(S.updated().at(-1) ?? {}))));
    const asked = S.asked.length;
    stub.push({ type: 'events_api', envelope_id: 'env-2', payload: ev });
    ok('Socket: a redelivered event is acknowledged and answered once', await until(async () => stub.acks.some((a) => a.envelope_id === 'env-2'), 5000) && (await sleep(500), S.asked.length === asked));
    stub.push({ type: 'events_api', envelope_id: 'env-bad', payload: { type: 'event_callback' } });
    ok('Socket: an envelope that is no question (an unknown shape) is still acknowledged, so Slack stops sending it', await until(async () => stub.acks.some((a) => a.envelope_id === 'env-bad'), 5000));
    // A button press arrives as `interactive`.
    const q = (await S.questions()).find((x) => x.text === 'over the socket?');
    stub.push({ type: 'interactive', envelope_id: 'env-3', payload: { type: 'block_actions', team: { id: TEAM }, user: { id: 'U_BOSS' }, actions: [{ action_id: 'ord_feedback', value: `${q?.id}:helpful` }] } });
    ok('Socket: an interactive envelope (Helpful) is handled and acknowledged', await until(async () => (await S.questions()).find((x) => x.id === q?.id)?.feedback === 'helpful') && stub.acks.some((a) => a.envelope_id === 'env-3'));

    // Reconnect: Slack says disconnect, and a dropped socket.
    const connects = stub.socketConnects;
    stub.push({ type: 'disconnect', reason: 'refresh_requested' });
    await sleep(200);
    ok('Reconnect: on `disconnect` the pod reconnects', await until(async () => { await podA.tick(); return stub.socketConnects > connects && stub.sockets.size === 1; }, 8000));
    const connects2 = stub.socketConnects;
    stub.dropAll();
    ok('Reconnect: after the socket drops it connects again (with a backoff)', await until(async () => { await podA.tick(); return stub.socketConnects > connects2 && stub.sockets.size === 1; }, 8000));

    // Slots: a second pod takes the next one; ten held means nobody else connects, and questions are still answered.
    const podB = socketMod.startSocketManager('pod-b/1', quiet);
    await podB.tick();
    ok('Slots: a second pod takes slot 2 and holds its own connection', await until(async () => stub.sockets.size === 2, 5000)
      && (await W.pool.query(`SELECT slot FROM slack_socket_slots WHERE team_id = $1 ORDER BY slot`, [TEAM])).rows.map((r) => r.slot).join() === '1,2');
    await podB.stop();
    ok('Slots: a pod that stops releases its slot', (await W.pool.query(`SELECT slot FROM slack_socket_slots WHERE team_id = $1`, [TEAM])).rows.map((r) => r.slot).join() === '1');
    for (let s = 2; s <= 10; s++) await W.pool.query(`INSERT INTO slack_socket_slots (team_id, slot, lease_owner, lease_until) VALUES ($1, $2, 'other-pod', now() + interval '1 hour')`, [TEAM, s]);
    const taken = await store.takeSlot(TEAM, 'pod-c/1', 800);
    ok('Slots: with all ten held a new pod is given none (it connects nothing, but still answers questions)', taken === null);
    const podC = socketMod.startSocketManager('pod-c/1', quiet);
    const opens = stub.callsOf('apps.connections.open').length;
    await podC.tick();
    await sleep(300);
    ok('Slots: a pod without a slot opens no connection', stub.callsOf('apps.connections.open').length === opens && podC.connected() === 0);
    await podC.stop();
    S.answer = { text: 'No-slot answer 7.', datasets: [W.plain] };
    await S.deliver(S.dm('boss', 'no slot here?', { id: 'EvNoSlot' })); // over the Events route: any pod serves any question
    ok('Slots: questions are still claimed and answered by every pod', /No-slot answer 7/.test(JSON.stringify(S.updated().at(-1) ?? {})));
    // A lapsed lease is free again.
    await W.pool.query(`UPDATE slack_socket_slots SET lease_until = now() + interval '1 hour' WHERE slot = 1`); // pod A's own is live
    await W.pool.query(`UPDATE slack_socket_slots SET lease_until = now() - interval '1 second' WHERE lease_owner = 'other-pod' AND slot = 5`);
    ok('Slots (negative control): a lapsed lease frees its slot for another pod', (await store.takeSlot(TEAM, 'pod-d/1', 800)) === 5);
    await W.pool.query(`DELETE FROM slack_socket_slots WHERE lease_owner <> $1 AND team_id = $2`, ['x', TEAM]);

    // Back to Events: the socket is closed and the slot released.
    await W.call('boss', 'slack:settings', { mode: 'events' });
    await podA.tick();
    ok('Mode: back to Events mode closes the socket and releases the slot', await until(async () => stub.sockets.size === 0, 5000)
      && (await W.pool.query(`SELECT 1 FROM slack_socket_slots WHERE team_id = $1`, [TEAM])).rowCount === 0);
    const noToken = await W.call('boss', 'slack:settings', { mode: 'socket' });
    ok('Mode: Socket Mode is accepted when an app-level token is stored (the control for the refusal below)', noToken.body.ok === true);
    await store.dropSecrets('acme');
    await store.saveInstall({ teamId: TEAM, orgId: 'acme', teamName: 'x', enterpriseId: null, appId: 'A', botUserId: stub.team.botUser, clientId: 'c', mode: 'events' });
    ok('Mode: with no app-level token stored, the setting is refused', (await W.call('boss', 'slack:settings', { mode: 'socket' })).body.ok === false);
  } finally {
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
