// The message Slack shows: the model's sentence (escaped), a table, Open in Ordinate and the buttons. Figures are the
// engine's, formatted HERE on the server before any sentence is made. No SQL text, no file path, no connection URL
// ever goes in: the card the browser may read has none.
//
// Escaping: the model's sentence is escaped for Slack (`&`, `<`, `>`), so it can never produce `<!channel>`, `<!here>`,
// `<@U…>` or a hidden link. A note about a refused or private answer is a fixed sentence (./../slackMessages.ts).

import { formatNumber } from '../../app/format';
import * as say from '../slackMessages';
import type { Card } from './ask';
import { FEEDBACK_ID, SHARE_ID } from './events';

export interface Message { text: string; blocks: unknown[] }

/** Slack mrkdwn escapes: the three characters it treats as markup. */
export const escapeSlack = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const TABLE_ROWS = 20;
const MAX_COLUMNS = 10;

/** A one-section message of fixed words. */
export function note(text: string, blocks: unknown[] = []): Message {
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: escapeSlack(text) } }, ...blocks] };
}

export function connectPrompt(url: string): Message {
  return note(say.connectPrompt(), [{ type: 'actions', elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: say.connectButton() }, url }] }]);
}

const cell = (v: unknown): string => (v === null || v === undefined || v === '' ? '–' : typeof v === 'number' ? formatNumber(v, { maxDecimals: 2 }) : String(v));

/** The card's data as a header row and body rows, or null when it has none. Every number is formatted; none is computed. */
export function tableOf(card: Card | null): { header: string[]; rows: string[][]; total: number } | null {
  if (!card) return null;
  if (card.kind === 'sql' && Array.isArray(card.columns) && Array.isArray(card.rows)) {
    const cols = (card.columns as Array<{ name: string }>).slice(0, MAX_COLUMNS);
    return { header: cols.map((c) => String(c.name)), rows: (card.rows as unknown[][]).map((r) => cols.map((_, i) => cell(r[i]))), total: Number(card.rowCount ?? card.rows.length) };
  }
  const d = card.data as { labels?: unknown[]; series?: Array<{ name: string; values: unknown[] }> } | undefined;
  if (!d || !Array.isArray(d.labels) || !Array.isArray(d.series) || !d.series.length) return null;
  const series = d.series.slice(0, MAX_COLUMNS - 1);
  const category = typeof card.spec?.category === 'string' ? card.spec.category : typeof card.spec?.category?.column === 'string' ? card.spec.category.column : '';
  return {
    header: [category, ...series.map((s) => s.name)],
    rows: d.labels.map((l, i) => [cell(l), ...series.map((s) => cell(s.values[i]))]),
    total: d.labels.length,
  };
}

export function tableBlock(t: { header: string[]; rows: string[][] }): unknown {
  const raw = (text: string) => ({ type: 'raw_text', text: clip(text, 300) });
  return { type: 'table', rows: [t.header.map(raw), ...t.rows.slice(0, TABLE_ROWS).map((r) => r.map(raw))] };
}

export interface AnswerParts {
  /** The model's sentence, already through the ask's guard and number audit. */
  sentence: string;
  /** The share policy masked or held back something in the card: the model's sentence AND its title are replaced by fixed words. */
  masked: boolean;
  /** The sentence could cite a marked column's values (./shape.ts sentenceAtRisk): replaced by the fixed caption, the card as it is. */
  atRisk?: boolean;
  card: Card | null;
  agent: string | null;
  datasets: string[];
  questionId: string;
  openUrl: string | null;
  /** A chart block when the result fits one exactly (./charts.ts), else the table. */
  chart?: unknown[] | null;
  /** The private answer to a channel question: offer Share to channel. */
  share?: boolean;
  /** A line above the answer (the private message's intro). */
  intro?: string;
}

export function answerMessage(p: AnswerParts): Message {
  const sentence = p.masked || p.atRisk ? say.maskedCaption() : p.sentence;
  // The card's title is the model's (or the question's) words, which may quote a masked value: a fixed one when anything was masked.
  const shownTitle = p.masked ? say.maskedTitle() : typeof p.card?.title === 'string' ? p.card.title : '';
  const title = shownTitle ? `*${escapeSlack(clip(shownTitle, 150))}*\n` : '';
  const blocks: unknown[] = [];
  if (p.intro) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: escapeSlack(p.intro) }] });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(title + escapeSlack(sentence), 2900) } });
  const table = tableOf(p.card);
  if (p.chart && p.chart.length) blocks.push(...p.chart);
  else if (table && table.rows.length) blocks.push(tableBlock(table));
  const footer = [say.footer(p.agent ?? say.projectAssistant(), p.datasets.join(', '))];
  if (table && table.total > TABLE_ROWS) footer.push(say.moreRows(String(Math.min(TABLE_ROWS, table.rows.length)), String(table.total)));
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: escapeSlack(clip(footer.join(' '), 2900)) }] });
  const buttons: unknown[] = [];
  if (p.openUrl) buttons.push({ type: 'button', text: { type: 'plain_text', text: say.openInOrdinate() }, url: p.openUrl });
  buttons.push(
    { type: 'button', action_id: FEEDBACK_ID, text: { type: 'plain_text', text: say.helpful() }, value: `${p.questionId}:helpful` },
    { type: 'button', action_id: FEEDBACK_ID + '_no', text: { type: 'plain_text', text: say.notHelpful() }, value: `${p.questionId}:not_helpful` },
  );
  if (p.share) buttons.push({ type: 'button', action_id: SHARE_ID, text: { type: 'plain_text', text: say.shareToChannel() }, value: `${p.questionId}:share` });
  blocks.push({ type: 'actions', elements: buttons });
  return { text: clip(escapeSlack(sentence), 3000), blocks }; // the notification text is mrkdwn too: escaped alike
}
