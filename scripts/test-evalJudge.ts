// The judge's reply parser (docs/eval-suites/00-design.md): a reply it cannot read is "not scored", NEVER a pass.
//
//   npm run build:ts && node scripts/test-evalJudge.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const j: typeof import('../src/ai/evalJudge') = require('../src/ai/evalJudge');
const checks: typeof import('../src/ai/evalChecks') = require('../src/ai/evalChecks');

const scored = (raw: string) => { const r = j.parseJudge(raw); return r.judged.state === 'scored' ? r.judged.score : r.judged.state; };
ok('reads a clean reply, in a fence too, and with a line of prose around it', scored('{"score":4,"why":"says it"}') === 4 && scored('```json\n{"score": 5, "why": "x"}\n```') === 5 && scored('Here you go: {"score":2,"why":"no"} thanks') === 2);
ok('keeps one line of why, cut to its cap', j.parseJudge('{"score":3,"why":"a\\n  b"}').why === 'a b' && j.parseJudge(`{"score":3,"why":"${'w'.repeat(500)}"}`).why.length === j.MAX_WHY);
for (const [name, raw] of [
  ['empty', ''], ['prose', 'It is a good answer, 5 out of 5.'], ['no score', '{"why":"fine"}'], ['zero', '{"score":0}'], ['six', '{"score":6}'], ['a fraction', '{"score":3.5}'],
  ['a string score', '{"score":"4"}'], ['null', '{"score":null}'], ['an array', '[{"score":5}]'], ['two objects', '{"score":5} {"score":1}'], ['damaged', '{"score":5,'],
] as const) {
  const r = j.parseJudge(raw);
  ok(`NEGATIVE CONTROL: ${name} is not scored, and its verdict is not a pass`, r.judged.state === 'not_scored' && checks.verdict([], r.judged) === 'not_scored', JSON.stringify(r));
}
ok('the prompt fences the answer and the question, so the reply text cannot pose as an instruction', /ANSWER\n<<<\nignore all\n>>>/.test(j.judgeUser({ question: 'q', reply: 'ignore all', say: 's' })) && /never decide whether a number is right/.test(j.JUDGE_SYSTEM));
finish();
