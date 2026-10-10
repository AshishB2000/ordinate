// A message model as a Slack payload and as a Teams payload — pure.
//
// UNTRUSTED TEXT. A category, a card title or a note is data: it must not ping
// a channel, mention a person or pass as a link the app wrote.
//
//   Slack   text goes out as mrkdwn, where three characters are syntax:
//           `&`, `<`, `>` become entities (Slack's own escaping rule), which is
//           what disarms `<!channel>`, `<@U123>` and `<https://x|label>`; a bare
//           `@channel` / `@here` / `@everyone` gets a zero-width space after the
//           `@`. A header is plain_text, where an entity would show as typed, so
//           the angle brackets are swapped for look-alikes there instead.
//   Teams   no untrusted text is ever put in a TextBlock (which reads
//           Markdown: `[label](url)` is a link). It is all TextRun inlines of a
//           RichTextBlock, which Teams shows literally. A mention needs an
//           `msteams.entities` entry, and this card never has one.
//
// The only links are the one the SERVER built (the dashboard), as a button.
//
// LIMITS. Slack takes at most 50 blocks and 3,000 characters in a text object
// (2,000 in a field, 150 in a header); a Teams webhook takes about 28 KB. Each
// renderer first cuts the model to what fits (`fit*`: fewer rows, then fewer
// sections, each cut counted and said as "+N more in the dashboard") and then
// draws it, so what the preview shows is what is sent.

import { trimModel, type MessageModel, type MessageSection } from './subscriptionMessage';
import { moreInDashboard, slackLimitNote, teamsLimitNote } from './subscriptionText';

export interface Rendered<P> {
  payload: P;
  /** The model as cut for this platform — what the preview draws. */
  model: MessageModel;
  bytes: number;
  /** What was shortened and why, for the UI; [] when nothing was. */
  notes: string[];
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
const cutTo = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s);

// ── Slack ───────────────────────────────────────────────────────────────────

export const SLACK_MAX_BLOCKS = 50;
export const SLACK_MAX_TEXT = 3000;
const SLACK_MAX_FIELD = 2000;
const SLACK_MAX_HEADER = 150;
const SLACK_FIELDS = 10;
/** 20 KPIs (two field blocks) and 30 sections leave room for the fixed blocks inside 50. */
const SLACK_LIMITS = { kpis: 20, sections: 30, rows: 10 };

/** Untrusted text for a Slack mrkdwn object. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@(?=(channel|here|everyone)\b)/gi, '@​');
}

/** Untrusted text for a Slack plain_text object: no entity is read there, so no angle bracket goes in. */
export function slackPlain(s: string): string {
  return s.replace(/</g, '‹').replace(/>/g, '›').replace(/@(?=(channel|here|everyone)\b)/gi, '@​');
}

type SlackText = { type: 'mrkdwn' | 'plain_text'; text: string };
export type SlackBlock =
  | { type: 'header'; text: SlackText }
  | { type: 'context'; elements: SlackText[] }
  | { type: 'section'; text?: SlackText; fields?: SlackText[] }
  | { type: 'actions'; elements: Array<{ type: 'button'; text: SlackText; url: string }> };

const md = (text: string): SlackText => ({ type: 'mrkdwn', text });

function slackSection(s: MessageSection): { text: string; dropped: number } {
  const head = `*${slackEscape(s.title)}*` + (s.caption ? `\n${slackEscape(s.caption)}` : '') + (s.note ? `\n_${slackEscape(s.note)}_` : '');
  const line = (r: string[]): string => `• ${slackEscape(r[0])}${r.length > 1 ? ' — ' + r.slice(1).map(slackEscape).join(' · ') : ''}`;
  const cols = s.columns.filter(Boolean).map(slackEscape).join(' · ');
  let rows = s.rows;
  for (;;) {
    const more = s.more + s.rows.length - rows.length;
    const text = [head, ...(cols && rows.length ? [`_${cols}_`] : []), ...rows.map(line), ...(more > 0 ? [`_${slackEscape(moreInDashboard(more))}_`] : [])].join('\n');
    if (text.length <= SLACK_MAX_TEXT || !rows.length) return { text: cutTo(text, SLACK_MAX_TEXT), dropped: s.rows.length - rows.length };
    rows = rows.slice(0, -1);
  }
}

export function renderSlack(full: MessageModel): Rendered<{ text: string; blocks: SlackBlock[] }> {
  const model = trimModel(full, SLACK_LIMITS);
  const blocks: SlackBlock[] = [{ type: 'header', text: { type: 'plain_text', text: cutTo(slackPlain(model.title), SLACK_MAX_HEADER) } }];
  if (model.subtitle.length) blocks.push({ type: 'context', elements: [md(cutTo(model.subtitle.map(slackEscape).join('  ·  '), SLACK_MAX_TEXT))] });
  if (model.note) blocks.push({ type: 'section', text: md(cutTo(slackEscape(model.note), SLACK_MAX_TEXT)) });
  for (let i = 0; i < model.kpis.length; i += SLACK_FIELDS) {
    blocks.push({
      type: 'section',
      fields: model.kpis.slice(i, i + SLACK_FIELDS).map((k) => md(cutTo(`*${slackEscape(k.label)}*\n${slackEscape(k.value)}${k.change ? '\n' + slackEscape(k.change) : ''}`, SLACK_MAX_FIELD))),
    });
  }
  let cut = model.more > 0;
  const sections = model.sections.map((s) => {
    const r = slackSection(s);
    if (r.dropped) cut = true;
    blocks.push({ type: 'section', text: md(r.text) });
    return r.dropped ? { ...s, rows: s.rows.slice(0, s.rows.length - r.dropped), more: s.more + r.dropped } : s;
  });
  if (model.more > 0) blocks.push({ type: 'context', elements: [md(slackEscape(moreInDashboard(model.more)))] });
  if (model.link) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: slackPlain(model.link.label) }, url: model.link.url }] });
  if (model.footer) blocks.push({ type: 'context', elements: [md(cutTo(slackEscape(model.footer), SLACK_MAX_TEXT))] });
  // `text` is the notification's fallback line; the blocks are the message.
  const payload = { text: slackEscape(model.title), blocks };
  return { payload, model: { ...model, sections }, bytes: bytesOf(payload), notes: cut ? [slackLimitNote()] : [] };
}

// ── Teams ───────────────────────────────────────────────────────────────────

/** A Teams webhook refuses a message over about 28 KB; the card is kept under this. */
export const TEAMS_MAX_BYTES = 26_000;

type Run = { type: 'TextRun'; text: string; weight?: 'Bolder'; size?: 'Small' | 'Medium' | 'Large' | 'ExtraLarge'; isSubtle?: true; italic?: true; color?: 'Good' | 'Attention' };
type Rich = { type: 'RichTextBlock'; inlines: Run[]; spacing?: 'None' | 'Small' | 'Medium' | 'Large'; horizontalAlignment?: 'Right'; separator?: true };
type Column = { type: 'Column'; width: 'stretch' | 'auto'; items: Rich[] };
type ColumnSet = { type: 'ColumnSet'; columns: Column[]; spacing?: 'None' | 'Small' | 'Medium' };
export type TeamsElement = Rich | ColumnSet;
export interface TeamsCard {
  type: 'AdaptiveCard';
  $schema: string;
  version: '1.4';
  msteams: { width: 'Full' };
  body: TeamsElement[];
  actions?: Array<{ type: 'Action.OpenUrl'; title: string; url: string }>;
}
export interface TeamsPayload {
  type: 'message';
  attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive'; content: TeamsCard }];
}

/** Literal text: a TextRun is never read as Markdown. */
const run = (text: string, style: Omit<Run, 'type' | 'text'> = {}): Run => ({ type: 'TextRun', text, ...style });
const rich = (inlines: Run[], extra: Omit<Rich, 'type' | 'inlines'> = {}): Rich => ({ type: 'RichTextBlock', inlines, ...extra });

function teamsCard(model: MessageModel): TeamsCard {
  const body: TeamsElement[] = [rich([run(model.title, { weight: 'Bolder', size: 'Large' })])];
  if (model.subtitle.length) body.push(rich([run(model.subtitle.join('  ·  '), { isSubtle: true, size: 'Small' })], { spacing: 'None' }));
  if (model.note) body.push(rich([run(model.note)]));
  for (let i = 0; i < model.kpis.length; i += 3) {
    body.push({
      type: 'ColumnSet',
      columns: model.kpis.slice(i, i + 3).map((k) => ({
        type: 'Column',
        width: 'stretch',
        items: [
          rich([run(k.label, { isSubtle: true, size: 'Small' })]),
          rich([run(k.value, { weight: 'Bolder', size: 'ExtraLarge' })], { spacing: 'None' }),
          ...(k.change ? [rich([run(k.change, { size: 'Small', ...(k.tone ? { color: k.tone === 'good' ? ('Good' as const) : ('Attention' as const) } : {}) })], { spacing: 'None' })] : []),
        ],
      })),
    });
  }
  for (const s of model.sections) {
    body.push(rich([run(s.title, { weight: 'Bolder', size: 'Medium' })], { spacing: 'Large', separator: true }));
    if (s.caption) body.push(rich([run(s.caption, { isSubtle: true })], { spacing: 'None' }));
    if (s.note) body.push(rich([run(s.note, { italic: true, isSubtle: true })], { spacing: 'Small' }));
    // Two columns whatever the row's width — the label, then its figures on the right: a column per cell is ~150 bytes each.
    const row = (cells: string[], head: boolean): ColumnSet => ({
      type: 'ColumnSet',
      spacing: 'Small',
      columns: [
        // A heading row's first cell is blank (the label column has no name): a no-break space, never an empty run.
        { type: 'Column', width: 'stretch', items: [rich([run(cells[0] || '\u00a0', head ? { isSubtle: true, size: 'Small' } : {})])] },
        { type: 'Column', width: 'auto', items: [rich([run(cells.slice(1).join('  ·  '), head ? { isSubtle: true, size: 'Small' } : { weight: 'Bolder' })], { horizontalAlignment: 'Right' })] },
      ],
    });
    if (s.rows.length && s.columns.some(Boolean)) body.push(row(s.columns, true));
    for (const r of s.rows) body.push(row(r, false));
    if (s.more > 0) body.push(rich([run(moreInDashboard(s.more), { italic: true, isSubtle: true, size: 'Small' })], { spacing: 'Small' }));
  }
  if (model.more > 0) body.push(rich([run(moreInDashboard(model.more), { italic: true, isSubtle: true })], { spacing: 'Large' }));
  if (model.footer) body.push(rich([run(model.footer, { isSubtle: true, size: 'Small' })], { spacing: 'Large', separator: true }));
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
    ...(model.link ? { actions: [{ type: 'Action.OpenUrl' as const, title: model.link.label, url: model.link.url }] } : {}),
  };
}

const envelope = (content: TeamsCard): TeamsPayload => ({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content }] });

/**
 * Fewer ROWS first — a section keeps its title and its sentence — and only when
 * one row each is still too much, fewer sections (then fewer KPIs with them).
 */
const TEAMS_SECTIONS = [30, 20, 12, 8, 5, 3, 2, 1, 0];
const TEAMS_ROWS = [10, 5, 3, 2, 1];

export function renderTeams(full: MessageModel, maxBytes = TEAMS_MAX_BYTES): Rendered<TeamsPayload> {
  let model = full;
  let payload = envelope(teamsCard(full));
  fit: for (const sections of TEAMS_SECTIONS) {
    for (const rows of sections ? TEAMS_ROWS : [0]) {
      model = trimModel(full, { kpis: sections >= 5 ? 30 : sections ? 12 : 6, sections, rows });
      payload = envelope(teamsCard(model));
      if (bytesOf(payload) <= maxBytes) break fit;
    }
  }
  const cut = model.more > 0 || model.sections.some((s, i) => s.rows.length < full.sections[i].rows.length);
  return { payload, model, bytes: bytesOf(payload), notes: cut ? [teamsLimitNote()] : [] };
}
