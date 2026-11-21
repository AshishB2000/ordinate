// Every sentence evaluation suites say from the server (docs/eval-suites/00-design.md) — MAIN, through the catalog. Its own file so the
// i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. A reason a case failed is a CODE the page
// words (src/ai/evalChecks.ts CheckCode): no model words and no figure ever travel as a sentence from here.

export function needsDb(): string {
  return 'Evaluation suites need the server’s database.';
}
export function notReady(): string {
  return 'Running tests needs an AI model. An admin sets one up in Admin → AI.';
}
export function notFound(): string {
  return 'That suite, case or run was not found.';
}
export function tooManySuites(max: string): string {
  return `A project holds at most ${max} suites.`;
}
export function suiteFull(max: string): string {
  return `A suite holds at most ${max} test cases.`;
}
export function suiteBusy(): string {
  return 'This suite has a run going. Stop it first.';
}
export function alreadyRunning(): string {
  return 'A test run is already going in this project. Stop it or wait for it to finish.';
}
export function emptySuite(): string {
  return 'Add a test case before running this suite.';
}
export function agentNotYours(): string {
  return 'You cannot use that assistant, so you cannot test it.';
}
export function badCase(): string {
  return 'A test case needs a question and what a good answer is: what it should compute, what it should say, or that it should refuse.';
}
export function sqlQuestion(): string {
  return 'A question answered with SQL cannot be a test yet.';
}
export function noChart(): string {
  return 'That answer has no chart to test. Add its question with words to check, or as one that should be refused.';
}
export function dataClosed(): string {
  return 'You cannot open the data this answer uses, so it cannot become a test.';
}
export function notResumable(): string {
  return 'This run cannot be resumed.';
}
export function judgeNotEnabled(): string {
  return 'That model is not enabled in Admin → AI.';
}
export function couldNotRate(): string {
  return 'That answer could not be rated.';
}
export function inboxGone(): string {
  return 'That question is no longer in the inbox.';
}
export function questionMissing(): string {
  return 'The question that came with this answer is not stored, so it cannot become a test.';
}
export function stopped(): string {
  return 'The run was stopped.';
}
