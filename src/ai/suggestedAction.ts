// The Copilot chat prompt, and the ONE structured field its answer carries.
//
// MAIN PROCESS ONLY. Pure: no fs, no net — everything here is a
// string in, a value out, which is what lets scripts/test-suggestedAction.ts
// drive it directly.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// The dock used to guess what a question wanted by running three regexes over
// it (dockPropose.ts's DK_*_HINT_RE). That heuristic could not tell "show me
// revenue by region" from "build me a dashboard of revenue by region", and had
// no notion of a dashboard at all. Its own ponytail comment named the fix:
// have copilot:ask return a `suggestedAction` alongside the answer. This is it.
//
// The model proposes an ACTION and an INTENT — never a number, never a plan.
// What the action leads to (analysis:draft → validatePlan → previewPlan) is app
// code that re-decides everything for itself; this field only says which door
// to knock on.
//
// The one kind that carries a third field is 'style', and it carries a PRESET
// NAME, not a style: the app owns the four triples in dashboards.ts, so the
// model picks a door here too — it never names a colour and never writes CSS.
//
// ── Why a sentinel, and not JSON ────────────────────────────────────────────
// The chat answer STREAMS (askCopilot's onDelta → copilot:ask:chunk → the live
// bubble). A JSON envelope would mean either buffering the whole answer before
// showing any of it — losing streaming — or letting the user watch raw JSON
// type itself out. So the answer stays prose and the action is one final line
// behind a marker, which `makeActionFilter` withholds from the stream and
// `splitAction` removes from the stored text. The user never sees it.
//
// A missing, malformed or unknown action is NOT an error: it means 'none', and
// the turn is simply an answer with no proposal. That is the common case for a
// weaker local CLI, and it must degrade quietly.
//
// ── Why the sentinel is not enough ──────────────────────────────────────────
// The marker is a REQUEST, not a guarantee, and two things routinely break it:
//
//  1. The model drops it. It was told to write one final line; a weaker CLI
//     writes the JSON and forgets the prefix. With only a marker search, that
//     line is prose — and when it is the ONLY thing left, the user's answer was
//     literally `{"kind":"none","intent":""}`. That is the bug this file's
//     stripping now covers: the JSON SHAPE is matched whether the marker is
//     there or not, on its own line, anywhere in the tail.
//  2. Something upstream eats the prose around it. A local CLI adapter used to
//     run every reply — prose ones included — through its JSON-envelope hunter
//     (the desktop's local-CLI extractEnvelope), which found the action line's
//     `{…}` first and returned THAT as the whole reply. Fixed at the source with
//     `prose: true`; this file is the second line of defence, not the first.
//
// Both end the same way: nothing usable left. An empty bubble is not an answer
// and neither is a brace, so `splitAction` substitutes EMPTY_ANSWER — one
// app-written sentence, chosen here so every caller gets it without asking.

import type { DashboardStylePreset } from '../analysis/dashboards';
import { PLAN_PROMPT, MAX_PLAN_CHARS, sanitizePlanSteps } from './planSteps';
import type { PlanStep } from './planSteps';

/** The marker opening the action line. Chosen to be something no prose answer
 *  would produce on its own, and to survive a model that strips markdown. */
export const ACTION_MARKER = '@@ACTION';
/** ACTION_MARKER escaped for a RegExp source. Spelled out rather than derived,
 *  so a marker that gains a metacharacter fails tsc here and not silently. */
const ACTION_MARKER_SRC = '@@ACTION';

/** Longest intent we carry forward. The intent is model text used to re-prompt
 *  (analysis:draft) and shown in the composer on "Adjust…", so it is bounded
 *  like every other model string that reaches the UI. */
export const MAX_INTENT = 400;

/** The whitelist. Anything not on it becomes 'none'. */
export type SuggestedActionKind = 'dashboard' | 'edit' | 'chart' | 'step' | 'calc' | 'style' | 'answer' | 'story' | 'plan' | 'none';
const KIND_LIST = ['dashboard', 'edit', 'chart', 'step', 'calc', 'style', 'answer', 'story', 'plan', 'none'] as const;

/** The most JSON an answer's spec may carry. A spec names a dataset, a few
 *  columns and a few filter values; anything longer is not a spec. */
export const MAX_SPEC_CHARS = 4000;
const KINDS: ReadonlySet<string> = new Set(KIND_LIST);

/**
 * An action line, WITH OR WITHOUT the marker: an object opening with a
 * whitelisted `"kind"`, alone on its line.
 *
 * Built from KIND_LIST, so it cannot drift from the whitelist `validateAction`
 * enforces one function below. Three deliberate tightenings, because this is the
 * pattern that decides what is thrown away:
 *
 *  - THE KIND MUST BE ON THE WHITELIST. `{"kind":"banana"}` is not an action
 *    line, it is prose that happens to be JSON, and prose is kept.
 *  - `"intent"` must be there too. One field is a fragment; the contract is two.
 *  - IT MUST OWN ITS LINE (`^`…`$` under /m, whitespace allowed either side).
 *    An answer that quotes the format mid-sentence — "I would emit
 *    {"kind":"none","intent":""} normally" — is an answer ABOUT the format, and
 *    deleting half that sentence would be a worse bug than the one this fixes.
 *
 * The trailing `\n?` takes the line's own newline with it. Without it, removing
 * a line from the MIDDLE of an answer leaves the blank line behind — a visible
 * hole where the wiring used to be, which is most of what we set out to hide.
 *
 * A fresh RegExp per call: /g carries `lastIndex` between uses, and a shared one
 * would skip every other match in exactly the multi-line case this exists for.
 */
const ACTION_LINE_SRC =
  '^[ \\t]*(?:' + ACTION_MARKER_SRC + '[ \\t]*)?' +
  '\\{[ \\t]*"kind"[ \\t]*:[ \\t]*"(?:' + KIND_LIST.join('|') + ')"[^\\n]*"intent"[^\\n]*\\}[ \\t]*$\\n?';
function actionLineRe(): RegExp { return new RegExp(ACTION_LINE_SRC, 'gm'); }

/**
 * What the user is shown when stripping leaves nothing.
 *
 * The model DID answer — it just answered entirely in machine text. The two
 * alternatives are both worse: an empty bubble reads as a crash, and the JSON is
 * the bug. This is app-written, so it is safe to show under any model, and it
 * says the one thing a blank turn should say — what to type next.
 */
export const EMPTY_ANSWER = 'Ask me about your data — e.g. \'revenue by region\'.';

// The four preset NAMES, spelled out here and imported only as a TYPE.
//
// `import type` is erased at compile time, so this file keeps the purity its
// header claims. A runtime import would not: dashboards.ts pulls in visuals.ts,
// which pulls in `fs`, projects and datasets — every plain-node test that
// requires dashboards.ts has to point userData at a temp dir first, and forcing
// that on a string-in/value-out parser (and on the test that
// drives it) to reach four string literals is a bad trade.
//
// The Record below is the drift guard that makes the duplication safe in BOTH
// directions: a preset renamed or removed in dashboards.ts leaves a key here
// that is no longer in the union, and a preset ADDED there leaves this Record
// non-exhaustive. Either way tsc fails on this file until the list is updated,
// which is stronger than a runtime equality test and costs nothing.
const STYLE_PRESET_TABLE: Record<DashboardStylePreset, true> = {
  auto: true,
  clean: true,
  executive: true,
  dense: true,
  dark: true,
};
const STYLE_PRESETS: ReadonlySet<string> = new Set(Object.keys(STYLE_PRESET_TABLE));

export interface SuggestedAction {
  kind: SuggestedActionKind;
  intent: string;
  /** Which named style to apply. Present ONLY when `kind === 'style'`; the app
   *  expands it through DASHBOARD_STYLE_PRESETS, so the model never names a
   *  colour and never writes CSS. */
  preset?: DashboardStylePreset;
  /** The CHART SPEC behind an 'answer' — present ONLY when `kind === 'answer'`.
   *  Shape-checked here (a plain object, bounded); every NAME in it is resolved
   *  against the dataset's real columns by src/ai/answerSpec.ts before anything
   *  is computed, so it stays loosely typed until then. It never carries a figure. */
  spec?: Record<string, unknown>;
  /** The ordered steps behind a 'plan' — present ONLY when `kind === 'plan'`.
   *  Shape-checked here (src/ai/planSteps.ts); what each step MEANS is checked
   *  by src/ai/planCheck.ts before the card shows anything. */
  steps?: PlanStep[];
  /** How many entries of the model's plan were not steps at all. */
  droppedSteps?: number;
}

/** What an absent or unusable action means. Never null — callers switch on
 *  `.kind`, and a null here would just push that check to every call site. */
export const NO_ACTION: SuggestedAction = { kind: 'none', intent: '' };

// The prompt fragment describing the action line. Appended to the chat prompt
// below rather than inlined so the test can assert the whitelist and the marker
// in the prompt are the SAME constants the parser validates against — a prompt
// that drifts from its parser is the failure mode this pairing prevents.
const ACTION_PROMPT =
  '\n\nAFTER your answer, output ONE final line, exactly:\n' +
  ACTION_MARKER + ' {"kind":"<kind>","intent":"<intent>"}\n' +
  'where <kind> is one of: dashboard, story, edit, chart, step, calc, style, answer, plan, none. Use "dashboard" when the ' +
  'user is asking to BUILD or CREATE a NEW dashboard, report or overview; "story" when they want a WRITTEN ' +
  'piece instead — a story, write-up, narrative or brief to be read top to bottom, with charts in it; "edit" when the FACTS ' +
  'show a dashboard is already open and they are asking to CHANGE it — add, remove, move, retype ' +
  'or rename something on it; "chart" when they want a ' +
  'single chart or visualisation; "step" when they want the data cleaned or filtered; "calc" when ' +
  'they want a new calculated column or formula; "style" when they want the dashboard they ' +
  'already have to LOOK different (darker, denser, more executive or more formal) rather than ' +
  'to contain anything new; and "none" for an ordinary question. <intent> is a ' +
  'short restatement of what they want built, in their own terms, or "" when kind is none. ' +
  'For "style" ONLY, the line carries one extra field:\n' +
  ACTION_MARKER + ' {"kind":"style","intent":"<intent>","preset":"<preset>"}\n' +
  'where <preset> is EXACTLY one of: clean, executive, dense, dark. Lowercase, one word, ' +
  'nothing else. Pick the closest of the four; never name a colour, never write CSS, and never ' +
  'invent a preset. If none of the four fits what they asked for, use kind "none" instead. ' +
  'Use "answer" when the question can be answered with ONE chart of the data in the FACTS ' +
  '("revenue by region last quarter", "top 5 products by profit", "how did West do vs East"). ' +
  'For "answer" ONLY, the line carries a spec, all on the same single line:\n' +
  ACTION_MARKER + ' {"kind":"answer","intent":"<the question, restated>","spec":{"dataset":"<dataset name>",' +
  '"category":"<column>","measures":[{"column":"<column>","aggregation":"sum|avg|count|min|max"}],' +
  '"filters":[{"column":"<column>","op":"=","value":"<value>"}],"chartType":"<optional>","top":<optional N>}}\n' +
  'Name columns EXACTLY as the FACTS list them. A filter is {"column","op","value"} with op one of ' +
  '= != > < >= <= contains in (for "in", give "values":[…]); for a relative date use ' +
  '{"column":"<date column>","period":"last_month|last_quarter|last_year"}; for "X vs Y" filter the ' +
  'category with "in". "top" keeps the N largest. The spec NEVER contains a computed number. ' +
  'When the kind is "answer", your prose is ONE short sentence saying what the chart shows, with no ' +
  'figures at all — the app computes and displays them.' + PLAN_PROMPT + ' ' +
  'This line is machine-read and never shown; write nothing after it.';

/** The chat system prompt. Lives here so the answer contract and the action
 *  contract are one thing — they are read together and must change together. */
export const CHAT_SYSTEM_PROMPT =
  'You are the Ordinate Assistant, a data analysis assistant for the user\'s current workspace. ' +
  'You are given FACTS about the active project/dataset/visual/dashboard — columns, types, ' +
  'already-computed statistics, sample rows, and computed chart/metric values. ' +
  'Answer in plain, concise prose (no markdown, no code fences, no bullet lists unless asked). ' +
  'GROUND every claim in the facts provided. NEVER invent, round, or recompute any number — use ' +
  'ONLY the exact figures given to you; if a number you need is not in the facts, say you don\'t ' +
  'have it rather than estimating. When the data is ambiguous or insufficient to answer, say so ' +
  'plainly. Prefer insight over restating the numbers.' +
  ACTION_PROMPT;

/**
 * Validate one action object off the wire. Everything unrecognised → 'none'.
 *
 * This is the whitelist the brief requires, and it is deliberately total: it
 * takes `unknown` and always returns a usable SuggestedAction, so no caller can
 * forget to handle a malformed one.
 */
export function validateAction(raw: unknown): SuggestedAction {
  if (!raw || typeof raw !== 'object') return NO_ACTION;
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === 'string' && KINDS.has(o.kind)
    ? (o.kind as SuggestedActionKind)
    : 'none';
  if (kind === 'none') return NO_ACTION;

  // A 'style' action is worth exactly as much as its preset. The app owns the
  // styling; the model's whole job on this kind is to pick one of OUR four
  // names, so a preset that is missing, miscased, misspelled or invented means
  // it did not actually pick one. Defaulting would be the worse failure: the
  // user says "make it dark", the model writes "darker", and a one-click
  // confirm silently restyles their dashboard to `clean`. So an unusable preset
  // collapses the whole action to NO_ACTION — the prose answer stands with no
  // proposal behind it, which is the same rule this file's header already
  // states for a malformed action, applied one level down.
  if (kind === 'style' && !(typeof o.preset === 'string' && STYLE_PRESETS.has(o.preset))) {
    return NO_ACTION;
  }

  const intentRaw = typeof o.intent === 'string' ? o.intent : '';
  // Collapse whitespace before clamping: a model that pads with newlines would
  // otherwise spend the budget on them, and this string goes back into a prompt.
  const intent = intentRaw.replace(/\s+/g, ' ').trim().slice(0, MAX_INTENT);

  // An 'answer' is worth exactly as much as its spec, like a style and its
  // preset: no spec, or one that is not a plain bounded object, is no answer.
  if (kind === 'answer') {
    const spec = o.spec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return NO_ACTION;
    let size = Infinity;
    try { size = JSON.stringify(spec).length; } catch (_) { /* unserialisable — no spec */ }
    if (size > MAX_SPEC_CHARS) return NO_ACTION;
    return { kind, intent, spec: spec as Record<string, unknown> };
  }

  // A 'plan' is worth exactly as much as its steps, like an answer and its spec.
  if (kind === 'plan') {
    let size = Infinity;
    try { size = JSON.stringify(o.steps).length; } catch (_) { /* unserialisable — no plan */ }
    if (size > MAX_PLAN_CHARS) return NO_ACTION;
    const { steps, dropped } = sanitizePlanSteps(o.steps);
    if (!steps.length) return NO_ACTION;
    return dropped ? { kind, intent, steps, droppedSteps: dropped } : { kind, intent, steps };
  }

  // The returned literal IS the whitelist — every key not named here is dropped.
  // `preset` is named only on the style branch (and `spec` only on the answer
  // branch above), so a model cannot smuggle a restyle in on a 'dashboard'
  // proposal by tacking the field on.
  return kind === 'style'
    ? { kind, intent, preset: o.preset as DashboardStylePreset }
    : { kind, intent };
}

/**
 * Parse one action line's JSON, marker or no marker. Returns NO_ACTION for
 * anything unparseable — a broken line costs the proposal, never the answer.
 */
function parseActionLine(line: string): SuggestedAction {
  const open = line.indexOf('{');
  const close = line.lastIndexOf('}');
  if (open < 0 || close <= open) return NO_ACTION;
  try {
    return validateAction(JSON.parse(line.slice(open, close + 1)));
  } catch (_) {
    return NO_ACTION;
  }
}

/**
 * Split a raw reply into the prose the user sees and the action behind it.
 *
 * TWO passes, in this order, because they cover two different failures:
 *
 *  1. THE MARKER, if the model wrote one. The LAST one wins (a model that
 *     mentions the format mid-answer, or self-corrects, ends with the real one),
 *     the JSON is located by its own braces rather than by assuming the line is
 *     clean, and a fence the model opened around it is not left dangling.
 *  2. THE SHAPE, marker or not. Whatever survives pass 1 is swept for
 *     action-shaped lines (ACTION_LINE_SRC above) and they are REMOVED. This is
 *     what stops a model that forgot the prefix from printing its wiring into
 *     the user's bubble; if pass 1 found nothing, the last such line is also
 *     where the action comes from.
 *
 * Then the empty check: a reply that had content but is all machine text after
 * stripping becomes EMPTY_ANSWER, never a blank bubble. A reply that was empty
 * to begin with stays empty — that is a provider failure, and askCopilot turns
 * it into a real error rather than a cheerful prompt.
 */
export function splitAction(raw: string | null | undefined): { text: string; action: SuggestedAction } {
  const full = String(raw || '');
  let action = NO_ACTION;
  let text = full;

  const at = full.lastIndexOf(ACTION_MARKER);
  if (at >= 0) {
    text = full.slice(0, at).replace(/```(?:json)?\s*$/, '');
    action = parseActionLine(full.slice(at + ACTION_MARKER.length));
  }

  // Pass 2. `matchAll` before `replace` so the LAST surviving line can supply the
  // action when pass 1 did not — replace alone would not hand us the match.
  const leftovers = Array.from(text.matchAll(actionLineRe()));
  if (leftovers.length) {
    if (action.kind === 'none') action = parseActionLine(leftovers[leftovers.length - 1][0]);
    text = text.replace(actionLineRe(), '').replace(/```(?:json)?\s*$/, '');
  }

  text = text.trim();
  if (!text && full.trim()) text = EMPTY_ANSWER;
  return { text, action };
}

/**
 * Wrap a delta callback so the action line never reaches the stream.
 *
 * The hard part is a marker split across chunks: "…done.\n@@AC" then "TION {…}".
 * Emitting the first chunk verbatim would paint "@@AC" into the user's bubble
 * and no later chunk could take it back. So this holds back the last
 * ACTION_MARKER.length - 1 characters of everything it has not yet emitted —
 * the longest possible partial marker — and releases them only once more text
 * arrives to prove they were not the start of one.
 *
 * THE SAME PROBLEM WITHOUT A MARKER. A model that forgot the prefix streams a
 * bare `{` and then, one chunk at a time, its own wiring — and a fixed 7-char
 * hold cannot cover a line of unknown length. So an unemitted `{` that STARTS
 * ITS LINE is also held, for as long as what follows is still a live prefix of
 * `{"kind":"` (see couldOpenAction). It resolves one of three ways: the line
 * completes and is dropped like a marked one; it turns out to be ordinary prose
 * and is released the moment it stops matching; or the stream simply ends and
 * `flush()` releases it — a `{` is never lost, only ever delayed.
 *
 * Returns `{ onDelta, flush }`. `flush()` releases that withheld tail once the
 * stream is over and no action line ever arrived — without it, an answer with no
 * action line would permanently lose its last few characters from the live
 * bubble (a real bug, caught by test-suggestedAction.ts). After a marker, flush
 * is a no-op: everything from there on is the action, not prose.
 *
 * `onDelta` is `undefined` for a non-streaming caller, which stays untouched.
 */
const ACTION_OPEN = '{"kind":"';

/** Could `line` — an unfinished line that opened with `{` — still become an
 *  action line? True while it is a live prefix of `{"kind":"`, or has matched
 *  that opener and not closed yet. Whitespace is ignored so a model that
 *  pretty-prints `{ "kind" : …` is held too. False the instant it is plainly
 *  something else, which is what keeps a `{` in ordinary prose flowing. */
function couldOpenAction(line: string): boolean {
  const t = line.replace(/\s+/g, '');
  if (ACTION_OPEN.startsWith(t)) return true;         // still typing the opener
  return t.startsWith(ACTION_OPEN) && !t.endsWith('}'); // opener matched, still open
}

export function makeActionFilter(
  onDelta: ((delta: string) => void) | undefined,
): { onDelta: ((delta: string) => void) | undefined; flush: () => void } {
  if (!onDelta) return { onDelta: undefined, flush: () => { /* nothing streamed */ } };
  const hold = ACTION_MARKER.length - 1;
  let seen = '';    // everything received so far
  let emitted = 0;  // how much of `seen` has been forwarded
  let done = false; // an action line has arrived; nothing more is prose

  /** Index of the first unemitted `{` that opens its own line, or -1. */
  const lineOpenBrace = (): number => {
    for (let i = Math.max(emitted, 0); i < seen.length; i++) {
      if (seen[i] !== '{') continue;
      const before = seen.slice(seen.lastIndexOf('\n', i - 1) + 1, i);
      if (!before.trim()) return i;
    }
    return -1;
  };

  const stopAt = (at: number): void => {
    done = true;
    if (at > emitted) onDelta(seen.slice(emitted, at));
    emitted = at;
  };

  const push = (delta: string): void => {
    if (done) return;
    seen += String(delta || '');

    const at = seen.indexOf(ACTION_MARKER);
    if (at >= 0) return stopAt(at);

    // No marker — forward everything except the tail that could still become one.
    let safe = Math.max(emitted, seen.length - hold);

    // …and except an unmarked action line already under way.
    const brace = lineOpenBrace();
    if (brace >= 0 && brace < safe) {
      // Judge THAT LINE, not the rest of the stream: a finished line is decided
      // (action → stop, prose → release), an unfinished one is still in play.
      const nl = seen.indexOf('\n', brace);
      const line = (nl < 0 ? seen.slice(brace) : seen.slice(brace, nl)).trimEnd();
      if (actionLineRe().test(line)) return stopAt(brace); // complete — ends the prose, as a marker does
      if (nl < 0 && couldOpenAction(line)) safe = brace;
    }

    if (safe > emitted) {
      onDelta(seen.slice(emitted, safe));
      emitted = safe;
    }
  };

  const flush = (): void => {
    if (done || emitted >= seen.length) return;
    onDelta(seen.slice(emitted));
    emitted = seen.length;
  };

  return { onDelta: push, flush };
}
