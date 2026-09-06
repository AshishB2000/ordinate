// The Copilot chat prompt, and the ONE structured field its answer carries.
//
// MAIN PROCESS ONLY. Pure: no fs, no net, no electron — everything here is a
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

import type { DashboardStylePreset } from '../analysis/dashboards';

/** The marker opening the action line. Chosen to be something no prose answer
 *  would produce on its own, and to survive a model that strips markdown. */
export const ACTION_MARKER = '@@ACTION';

/** Longest intent we carry forward. The intent is model text used to re-prompt
 *  (analysis:draft) and shown in the composer on "Adjust…", so it is bounded
 *  like every other model string that reaches the UI. */
export const MAX_INTENT = 400;

/** The whitelist. Anything not on it becomes 'none'. */
export type SuggestedActionKind = 'dashboard' | 'chart' | 'step' | 'calc' | 'style' | 'none';
const KINDS: ReadonlySet<string> = new Set(['dashboard', 'chart', 'step', 'calc', 'style', 'none']);

// The four preset NAMES, spelled out here and imported only as a TYPE.
//
// `import type` is erased at compile time, so this file keeps the purity its
// header claims. A runtime import would not: dashboards.ts pulls in visuals.ts,
// which pulls in `electron`, `fs`, projects and datasets — every plain-node test
// that requires dashboards.ts has to stub `electron` through `Module._load`
// first, and forcing that on a string-in/value-out parser (and on the test that
// drives it) to reach four string literals is a bad trade.
//
// The Record below is the drift guard that makes the duplication safe in BOTH
// directions: a preset renamed or removed in dashboards.ts leaves a key here
// that is no longer in the union, and a preset ADDED there leaves this Record
// non-exhaustive. Either way tsc fails on this file until the list is updated,
// which is stronger than a runtime equality test and costs nothing.
const STYLE_PRESET_TABLE: Record<DashboardStylePreset, true> = {
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
  'where <kind> is one of: dashboard, chart, step, calc, style, none. Use "dashboard" when the ' +
  'user is asking to BUILD or CREATE a dashboard, report or overview; "chart" when they want a ' +
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
  // The returned literal IS the whitelist — every key not named here is dropped.
  // `preset` is named only on the style branch, so a model cannot smuggle a
  // restyle in on a 'dashboard' proposal by tacking the field on.
  return kind === 'style'
    ? { kind, intent, preset: o.preset as DashboardStylePreset }
    : { kind, intent };
}

/**
 * Split a raw reply into the prose the user sees and the action behind it.
 *
 * Tolerant on purpose — the model is being asked for a machine-readable line at
 * the end of a prose answer, and will sometimes fence it, prefix it, or emit it
 * twice. The LAST marker wins (a model that mentions the format mid-answer, or
 * self-corrects, ends with the real one), and the JSON is located by its own
 * braces rather than by assuming the line is clean.
 */
export function splitAction(raw: string | null | undefined): { text: string; action: SuggestedAction } {
  const full = String(raw || '');
  const at = full.lastIndexOf(ACTION_MARKER);
  if (at < 0) return { text: full.trim(), action: NO_ACTION };

  // Prose is everything before the marker, minus any code fence the model may
  // have opened around the line it was about to write.
  const text = full.slice(0, at).replace(/```(?:json)?\s*$/, '').trim();

  const tail = full.slice(at + ACTION_MARKER.length);
  const open = tail.indexOf('{');
  if (open < 0) return { text, action: NO_ACTION };
  const close = tail.lastIndexOf('}');
  if (close <= open) return { text, action: NO_ACTION };

  let parsed: unknown;
  try {
    parsed = JSON.parse(tail.slice(open, close + 1));
  } catch (_) {
    return { text, action: NO_ACTION }; // unparseable → no proposal, answer stands
  }
  return { text, action: validateAction(parsed) };
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
 * Returns `{ onDelta, flush }`. `flush()` releases that withheld tail once the
 * stream is over and no marker ever arrived — without it, an answer with no
 * action line would permanently lose its last few characters from the live
 * bubble (a real bug, caught by test-suggestedAction.ts). After a marker, flush
 * is a no-op: everything from there on is the action, not prose.
 *
 * `onDelta` is `undefined` for a non-streaming caller, which stays untouched.
 */
export function makeActionFilter(
  onDelta: ((delta: string) => void) | undefined,
): { onDelta: ((delta: string) => void) | undefined; flush: () => void } {
  if (!onDelta) return { onDelta: undefined, flush: () => { /* nothing streamed */ } };
  const hold = ACTION_MARKER.length - 1;
  let seen = '';    // everything received so far
  let emitted = 0;  // how much of `seen` has been forwarded
  let done = false; // the marker has arrived; nothing more is prose

  const push = (delta: string): void => {
    if (done) return;
    seen += String(delta || '');

    const at = seen.indexOf(ACTION_MARKER);
    if (at >= 0) {
      done = true;
      if (at > emitted) onDelta(seen.slice(emitted, at));
      emitted = at;
      return;
    }
    // No marker yet — forward everything except the tail that could still
    // become one.
    const safe = Math.max(emitted, seen.length - hold);
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
