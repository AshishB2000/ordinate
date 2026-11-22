// Thumbs without a database (the desktop and `AUTH_MODE=dev`): they follow the conversation, which is the project's copilot.json. The
// value rides on the turn; there is no inbox and no suite (those are Postgres rows). Always runs, no DATABASE_URL.
//
//   npm run build:ts && node scripts/test-evalThumbsFile.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-evalthumbs-'));
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const evalsRpc: typeof import('../src/server/evals/rpc') = require('../src/server/evals/rpc');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');

async function main(): Promise<void> {
  const pid = (await projects.createProject('Thumbs'))!.id;
  copilotIpc.register();
  evalsRpc.register();
  (analyze as any).askCopilot = async () => ({ ok: true, text: 'West leads.', suggestedAction: { kind: 'none', intent: '' } });
  (execConfig as any).executionReady = async () => true;
  const call = (ch: string, payload?: unknown): Promise<any> => handlers.get(ch)!({}, payload);
  const asked = await call('copilot:ask', { projectId: pid, context: {}, question: 'Who leads?' });
  const turn = asked.turns.at(-1);
  const rate = (value: string, reason?: string, turnId = turn.id) => call('feedback:rate', { projectId: pid, threadId: asked.threadId, turnId, value, ...(reason ? { reason } : {}) });

  const down = await rate('down', 'didnt_answer');
  ok('a thumbs-down is kept on the turn in copilot.json', down.ok === true && (await copilot.loadHistory(pid, asked.threadId)).find((t) => t.id === turn.id)?.feedback?.reason === 'didnt_answer');
  ok('it survives a reload of the history', (await call('copilot:history', { projectId: pid, threadId: asked.threadId })).turns.find((t: { id: string }) => t.id === turn.id).feedback.value === 'down');
  ok('the file holds the value and the reason, no word of the answer', /"feedback": \{\s*"value": "down",\s*"reason": "didnt_answer"\s*\}/.test(fs.readFileSync(copilot.copilotFilePath(pid), 'utf8')));
  ok('a flip to up drops the reason', (await rate('up', 'wrong_number')).ok === true && (await copilot.loadHistory(pid, asked.threadId)).find((t) => t.id === turn.id)?.feedback?.reason === undefined);
  ok('clearing removes it', (await rate('none')).ok === true && (await copilot.loadHistory(pid, asked.threadId)).find((t) => t.id === turn.id)?.feedback === undefined);
  ok('NEGATIVE CONTROL: a question turn and an unknown turn cannot be rated', (await rate('up', undefined, asked.turns[0].id)).ok === false && (await rate('up', undefined, 'nope')).ok === false);
  ok('no database: no inbox and no suites, said plainly', (await call('feedback:inbox', { projectId: pid })).items.length === 0 && (await call('eval:suites', { projectId: pid })).available === false && (await call('eval:suiteSave', { projectId: pid, name: 'x' })).ok === false);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
