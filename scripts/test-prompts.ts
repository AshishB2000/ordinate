// A prompt is a CONTRACT with the model, and nothing at runtime notices when it
// breaks: an empty or truncated system prompt still sends, still gets an answer,
// and the answer is just quietly worse. So the prompts that moved out of
// analyze.ts into src/ai/prompts.ts get pinned here.
//
// Two of the three pins are DIFFERENTIAL rather than hand-written, which is the
// house style and the only kind that cannot rot: the steps prompt is checked
// against the step types transforms.ts's dispatch() actually accepts (an
// unlisted type is silently skipped there, so a prompt naming one proposes
// steps that vanish), and the calc-field prompt against the real
// formulaEval.FUNCTIONS table. That one is one-directional on purpose: the
// prompt advertises a deliberately NARROW subset ("these functions ONLY"), so
// what must hold is that everything it names really compiles — not the reverse.
//
// SUGGEST_CHARTS_SYSTEM_PROMPT is deliberately NOT re-asserted here —
// test-suggest-charts-parse.ts already drives it end to end, including the
// no-numbers rule and the column whitelist.

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

// prompts.ts pulls in analysis/visuals for the chart whitelist, which touches
// app.getPath at load — the same one-seam stub the sibling suites use.
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-prompts-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_n: string) => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

const prompts: typeof import('../src/ai/prompts') = require('../src/ai/prompts');
const formulaEval: typeof import('../src/formula/formulaEval') = require('../src/formula/formulaEval');

const REPO = path.resolve(__dirname, '..');

// ── 1. Nothing arrived empty or truncated ───────────────────────────────────
const ALL: Array<[string, string]> = [
  ['EXPLAIN_SYSTEM_PROMPT', prompts.EXPLAIN_SYSTEM_PROMPT],
  ['SUGGEST_STEPS_SYSTEM_PROMPT', prompts.SUGGEST_STEPS_SYSTEM_PROMPT],
  ['SUGGEST_CHARTS_SYSTEM_PROMPT', prompts.SUGGEST_CHARTS_SYSTEM_PROMPT],
  ['SUGGEST_CALC_FIELD_SYSTEM_PROMPT', prompts.SUGGEST_CALC_FIELD_SYSTEM_PROMPT],
];
for (const [name, text] of ALL) {
  ok(`${name} is a substantial string`, typeof text === 'string' && text.length > 200,
    `${typeof text} of length ${text ? text.length : 0}`);
}

// ── 2. Every one still forbids the model writing a number ───────────────────
// The core principle: the app does the math. Each prompt says so in its own
// words, so the assertion is on NEVER + the word for what it must not do.
for (const [name, text] of ALL) {
  ok(`${name} still forbids the model computing/inventing a figure`,
    /NEVER\b/.test(text) && /\bnumber\b/.test(text), text.slice(0, 120));
}

// ── 3. The steps prompt lists exactly what transforms.ts accepts ────────────
// dispatch()'s switch IS the whitelist — an unknown type is skipped with a
// warning, never applied, so a prompt that names one wastes a whole turn.
const transformsSrc = fs.readFileSync(path.join(REPO, 'src/data/transforms.ts'), 'utf8');
const dispatchBody = /function dispatch\([\s\S]*?\n}/.exec(transformsSrc);
ok('transforms.ts still has a dispatch() switch to read', Boolean(dispatchBody));
const accepted = [...(dispatchBody ? dispatchBody[0] : '').matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
ok('…and it accepts a non-trivial set of step types', accepted.length >= 8, String(accepted.length));

const promptedSteps = [...prompts.SUGGEST_STEPS_SYSTEM_PROMPT.matchAll(/"type": "([a-z_]+)"/g)].map((m) => m[1]);
// The mask steps are withheld from the model ON PURPOSE (see prompts.ts): what
// is sensitive is the detector's call and the user's, never a model's.
const MASK_TYPES = ['mask_hash', 'mask_redact', 'mask_generalize'];
ok('…and it accepts the three mask steps', MASK_TYPES.every((t) => accepted.includes(t)), accepted.join(', '));
ok('the steps prompt names every step type transforms.ts accepts, except the mask steps',
  accepted.every((t) => promptedSteps.includes(t) || MASK_TYPES.includes(t)),
  'missing: ' + accepted.filter((t) => !promptedSteps.includes(t) && !MASK_TYPES.includes(t)).join(', '));
ok('…and never offers a mask step', !promptedSteps.some((t) => MASK_TYPES.includes(t)), promptedSteps.join(', '));
ok('…and names no step type it would skip',
  promptedSteps.every((t) => accepted.includes(t)),
  'unknown: ' + promptedSteps.filter((t) => !accepted.includes(t)).join(', '));

// ── 4. The calc-field prompt lists exactly the functions that compile ───────
const FN_LINE = /these functions ONLY: ([^.]+)\./.exec(prompts.SUGGEST_CALC_FIELD_SYSTEM_PROMPT);
ok('the calc-field prompt still declares its function whitelist', Boolean(FN_LINE));
const promptedFns = (FN_LINE ? FN_LINE[1] : '').split(',').map((s) => s.trim()).filter(Boolean);
const realFns = Object.keys(formulaEval.FUNCTIONS);
ok('…naming a real subset, not an empty one', promptedFns.length >= 10, String(promptedFns.length));
ok('…and every function it names really compiles',
  promptedFns.every((f) => realFns.includes(f)),
  'not in FUNCTIONS: ' + promptedFns.filter((f) => !realFns.includes(f)).join(', '));

// ── 5. The explain prompt is still prose-only ──────────────────────────────
// Its whole point is that it does NOT go through parseReply(); if it ever grows
// a JSON envelope, explainText returns the envelope to the user verbatim.
ok('the explain prompt still asks for plain prose, not JSON',
  /plain, concise prose/.test(prompts.EXPLAIN_SYSTEM_PROMPT)
  && !/JSON/.test(prompts.EXPLAIN_SYSTEM_PROMPT));

finish();
