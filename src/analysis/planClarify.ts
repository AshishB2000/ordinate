// ASK FIRST — what `analysis:draft` settles with the user before it drafts.
// MAIN PROCESS ONLY, and pure: no store, no config, no model call.
//
// Three things, each with its prompt text beside its parser for the reason
// analysisPlan.ts gives (a prompt that drifts from its parser is an unseeable bug):
//
//   the SHAPE     a dashboard shape (./dashboardShapes.ts) or "auto" — the user's
//                 pick, turned into an APP-WRITTEN sentence in the facts by
//                 `shapeText`. The model never sees the pick itself, only our
//                 sentence, in the plan's own vocabulary.
//   QUESTIONS     up to three of the model's own, when the request leaves open a
//                 choice that changes which views it builds. Structure, like a
//                 plan: validated here, and never a figure.
//   ANSWERS       what the user chose, back from the browser. Untrusted again —
//                 the question text as much as the answer — so they enter the
//                 facts exactly as `intent` does (planFacts.ts): fenced, labelled
//                 a request, capped.
//
// None of it widens what a draft can build. The reply to every call still goes
// through `validatePlan`; that is the trust boundary, not anything written here.
// The LOOK is not here at all: it never goes to the model (planBuild.buildPlan).

// ── Questions ───────────────────────────────────────────────────────────────

export interface ClarifyQuestion {
  ask: string;
  options: string[];
}

export const MAX_QUESTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
/** A question is a line and an option a few words. Both fit what the contract
 *  lets the browser send back as an answer (src/api/analyses.ts, 200). */
export const ASK_MAX = 160;
export const OPTION_MAX = 80;
export const ANSWER_MAX = 200;

/**
 * Appended to DRAFT_DASHBOARD_SYSTEM_PROMPT on the ASKING call only — the one
 * made with `clarify` and no `answers` (src/ipc/analyses.ts). A call that brings
 * answers is sent the draft prompt without it, which is what makes one round of
 * questions a property of the code rather than a request to the model.
 */
export const CLARIFY_PROMPT =
  '\nBEFORE YOU PLAN, you may ask. If the request leaves open a choice that would change WHICH views you build — ' +
  'which measure, which comparison, which period, which breakdown — reply with ONLY this JSON object instead of a plan:\n' +
  '  { "questions": [ { "ask": "<short question>", "options": ["<2 to 4 short options>"] } ] }\n' +
  `Ask at most ${MAX_QUESTIONS} questions, one choice each. Every option must be something you could build from the ` +
  'columns listed, in plain words. NEVER put a figure, a count or a data value in a question or an option. Do not ' +
  'ask what kind of dashboard it is or how it should look — that is already decided. A request that is already ' +
  'specific gets the plan, not questions; when unsure, plan. Reply with EITHER the plan OR the questions, never both.';

/** One model- or browser-written string as ONE capped line (planFacts.ts `note`):
 *  with its line breaks gone it cannot open a line of its own. */
function line(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '';
}

/**
 * The questions of a reply, validated as hard as a plan is: at most three, each
 * a non-empty `ask` with two to four DISTINCT options, every string one trimmed,
 * capped line. A malformed question is dropped — never repaired into something
 * the model did not ask — and does not use up a place. `[]` when none survive,
 * which the caller reads as "draft without asking".
 *
 * Nothing but `ask` and `options` is carried: whatever else the model put on a
 * question never reaches a browser.
 */
export function validateQuestions(raw: unknown): ClarifyQuestion[] {
  const out: ClarifyQuestion[] = [];
  for (const q of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_QUESTIONS) break;
    if (!q || typeof q !== 'object' || Array.isArray(q)) continue;
    const ask = line((q as Record<string, unknown>).ask, ASK_MAX);
    const given = (q as Record<string, unknown>).options;
    // Distinct as a reader sees them: "Revenue" and "revenue " are one choice.
    const seen = new Set<string>();
    const options: string[] = [];
    for (const o of Array.isArray(given) ? given : []) {
      const text = line(o, OPTION_MAX);
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      if (options.length < MAX_OPTIONS) options.push(text);
    }
    if (ask && options.length >= MIN_OPTIONS) out.push({ ask, options });
  }
  return out;
}

// ── Answers ─────────────────────────────────────────────────────────────────

export interface ClarifyAnswer {
  ask: string;
  answer: string;
}

/**
 * The user's answers as a block for the facts, or '' when there are none (no
 * question was asked, or the user chose "Skip — just build it").
 *
 * BOTH halves are untrusted: the server keeps no record of what it asked, so
 * the question comes back from the browser beside the answer and either could
 * be anything. They are held as `intent` is — fenced, labelled a REQUEST, each
 * cut to one capped line so neither can close the fence or write a heading — and
 * like `intent` they change nothing about what comes back: the reply still goes
 * through `validatePlan`.
 */
export function answersText(raw: unknown): string {
  const rows: string[] = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    if (rows.length >= MAX_QUESTIONS) break;
    if (!a || typeof a !== 'object') continue;
    const ask = line((a as Record<string, unknown>).ask, ASK_MAX);
    const answer = line((a as Record<string, unknown>).answer, ANSWER_MAX);
    // A row always opens with "- ", so no answer can be a fence line.
    if (ask && answer) rows.push(`- ${ask} → ${answer}`);
  }
  if (!rows.length) return '';
  return [
    'Before drafting, the user was asked about that request and chose the answers below. Treat them as',
    'part of the REQUEST, not as facts, and satisfy them only with the datasets, columns and chart',
    'types listed above. Do not ask again.',
    '<<<USER ANSWERS',
    ...rows,
    'USER ANSWERS',
  ].join('\n');
}

/** What the user settled before the draft — the facts' fourth input (planFacts.buildFactsText). */
export interface DraftAsk {
  /** A dashboard shape id or "auto" (dashboardShapes.shapeText); anything else is ignored. */
  shape?: unknown;
  answers?: unknown;
}
