// A thumbs up or down on an Assistant answer (docs/eval-suites/00-design.md, phase 1): the turn's `feedback` key. PURE.
// It holds a value and a reason code, never a word of the answer. The question text that a thumbs-down shares with the editors is
// copied into `assistant_feedback` by src/server/evals/feedback.ts, not kept here.

export const FEEDBACK_VALUES = ['up', 'down'] as const;
export type FeedbackValue = (typeof FEEDBACK_VALUES)[number];
export const FEEDBACK_REASONS = ['wrong_number', 'wrong_data', 'didnt_answer', 'other'] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
export interface Feedback { value: FeedbackValue; reason?: FeedbackReason }

/** A stored or sent feedback in its one shape: a reason only on a thumbs-down. Undefined when it is not one. */
export function sanitizeFeedback(raw: unknown): Feedback | undefined {
  const f = raw as { value?: unknown; reason?: unknown } | null;
  if (!f || typeof f !== 'object' || !FEEDBACK_VALUES.includes(f.value as FeedbackValue)) return undefined;
  const value = f.value as FeedbackValue;
  const reason = FEEDBACK_REASONS.find((r) => r === f.reason);
  return value === 'down' && reason ? { value, reason } : { value };
}
