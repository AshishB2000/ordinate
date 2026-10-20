// A message model as an email — PURE (docs/email/00-design.md §7). The third
// rendering of the one model Slack and Teams are drawn from
// (./subscriptionRender.ts): the server's figures as composed, never
// recomputed; an HTML part and a text part that says the same.
//
// UNTRUSTED TEXT. Every string — a category, a title, a note, the channel's
// name — is HTML-escaped. The ONLY link is the one the server built (the
// dashboard, from ORDINATE_PUBLIC_URL), and only when it is http(s); no <a> is
// ever built from data, so a link's label can never differ from its target. No
// image, no <style>, no script: inline styles only, the accent (already a
// validated #rrggbb) the one dynamic style value. An author's note is
// attributed to the account the send runs as ("Note from …").
//
// No logo (§7.3): an SVG logo does not render in Gmail or Outlook, a CID part
// reads as an attachment in several clients, and a remote image is a beacon.

import { trimModel, type MessageModel, type MessageSection } from './subscriptionMessage';
import { emailReason, moreInDashboard, noteFrom } from './subscriptionText';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /** The model as cut — what the preview draws. What was cut is said in it ("+N more in the dashboard"). */
  model: MessageModel;
  bytes: number;
  /** Always [] — no platform limit to explain (the Slack / Teams previews' notes). */
  notes: string[];
}

export interface EmailLook {
  /** The channel's name, for the line that says why the reader has this. */
  channelName: string;
  /** '#rrggbb' from the org's branding, or '' for the app's blue. */
  accent: string;
  /** The sender's name (SMTP_FROM), shown above the title. */
  brand: string;
  lang?: string;
}

export const EMAIL_LIMITS = { kpis: 30, sections: 30, rows: 10 };
const BLUE = '#2563eb';
const HEX = /^#[0-9a-f]{6}$/i;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const safeLink = (url: string | undefined): string | null => (url && /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : null);

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MUTED = 'color:#6b7280;';

function sectionHtml(s: MessageSection): string {
  const e = escapeHtml;
  const cols = s.columns.some(Boolean) && s.rows.length ? s.columns : [];
  const cell = (v: string, i: number, head: boolean): string => {
    const align = i === 0 ? 'left' : 'right';
    const style = `padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:${align};${head ? 'font-weight:600;font-size:12px;' + MUTED : i === 0 ? '' : 'font-weight:600;white-space:nowrap;'}`;
    return head ? `<th style="${style}">${e(v)}</th>` : `<td style="${style}">${e(v)}</td>`;
  };
  return [
    `<tr><td style="padding:22px 28px 0;">`,
    `<h2 style="margin:0 0 4px;font-size:16px;line-height:1.35;color:#111827;">${e(s.title)}</h2>`,
    s.caption ? `<div style="font-size:13px;line-height:1.5;${MUTED}margin-bottom:8px;">${e(s.caption)}</div>` : '',
    s.note ? `<div style="font-size:13px;line-height:1.5;font-style:italic;${MUTED}">${e(s.note)}</div>` : '',
    s.rows.length
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;color:#1f2933;">`
        + (cols.length ? `<tr>${cols.map((c, i) => cell(c, i, true)).join('')}</tr>` : '')
        + s.rows.map((r) => `<tr>${r.map((v, i) => cell(v, i, false)).join('')}</tr>`).join('')
        + `</table>`
      : '',
    s.more > 0 ? `<div style="font-size:12px;font-style:italic;${MUTED}margin-top:6px;">${e(moreInDashboard(s.more))}</div>` : '',
    `</td></tr>`,
  ].join('');
}

function htmlOf(m: MessageModel, look: EmailLook, link: string | null): string {
  const e = escapeHtml;
  const accent = HEX.test(look.accent) ? look.accent.toLowerCase() : BLUE;
  const tone = (t?: 'good' | 'bad'): string => (t === 'good' ? 'color:#15803d;' : t === 'bad' ? 'color:#b91c1c;' : MUTED);
  const kpiRows: string[] = [];
  for (let i = 0; i < m.kpis.length; i += 3) {
    kpiRows.push(`<tr>${m.kpis.slice(i, i + 3).map((k) => `<td width="33%" style="padding:6px;vertical-align:top;">`
      + `<div style="border:1px solid #e5e7eb;border-radius:6px;padding:12px 14px;">`
      + `<div style="font-size:12px;${MUTED}">${e(k.label)}</div>`
      + `<div style="font-size:24px;line-height:1.2;font-weight:700;color:#111827;margin-top:4px;">${e(k.value)}</div>`
      + (k.change ? `<div style="font-size:12px;margin-top:4px;${tone(k.tone)}">${e(k.change)}</div>` : '')
      + `</div></td>`).join('')}</tr>`);
  }
  return [
    `<!doctype html><html lang="${e(look.lang || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(m.title)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f4f5f7;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;border-top:4px solid ${accent};font-family:${FONT};color:#1f2933;">`,
    `<tr><td style="padding:24px 28px 4px;">`,
    `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;${MUTED}">${e(look.brand)}</div>`,
    `<h1 style="margin:6px 0 6px;font-size:22px;line-height:1.3;color:#111827;">${e(m.title)}</h1>`,
    m.subtitle.length ? `<div style="font-size:13px;line-height:1.5;${MUTED}">${m.subtitle.map(e).join(' &middot; ')}</div>` : '',
    `</td></tr>`,
    m.note
      ? `<tr><td style="padding:14px 28px 0;"><div style="padding:12px 14px;background:#f9fafb;border-left:3px solid #d1d5db;font-size:14px;line-height:1.5;">`
        + (m.noteBy ? `<strong>${e(noteFrom(m.noteBy))}</strong> ` : '') + `${e(m.note)}</div></td></tr>`
      : '',
    kpiRows.length ? `<tr><td style="padding:14px 22px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${kpiRows.join('')}</table></td></tr>` : '',
    ...m.sections.map(sectionHtml),
    m.more > 0 ? `<tr><td style="padding:16px 28px 0;font-size:13px;font-style:italic;${MUTED}">${e(moreInDashboard(m.more))}</td></tr>` : '',
    link && m.link
      ? `<tr><td style="padding:24px 28px 0;"><a href="${e(link)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:6px;">${e(m.link.label)}</a></td></tr>`
      : '',
    `<tr><td style="padding:24px 28px 24px;"><div style="border-top:1px solid #e5e7eb;padding-top:14px;font-size:12px;line-height:1.5;${MUTED}">`,
    m.footer ? `<div>${e(m.footer)}</div>` : '',
    `<div>${e(emailReason(look.channelName))}</div>`,
    `</div></td></tr></table></td></tr></table></body></html>`,
  ].join('');
}

function textOf(m: MessageModel, look: EmailLook, link: string | null): string {
  const out: string[] = [look.brand, m.title];
  if (m.subtitle.length) out.push(m.subtitle.join(' · '));
  if (m.note) out.push('', m.noteBy ? `${noteFrom(m.noteBy)} ${m.note}` : m.note);
  if (m.kpis.length) out.push('', ...m.kpis.map((k) => `${k.label}: ${k.value}${k.change ? ` (${k.change})` : ''}`));
  for (const s of m.sections) {
    out.push('', s.title);
    if (s.caption) out.push(s.caption);
    if (s.note) out.push(s.note);
    const cols = s.columns.filter(Boolean);
    if (cols.length && s.rows.length) out.push(cols.join(' · '));
    for (const r of s.rows) out.push(`• ${r[0]}${r.length > 1 ? ' — ' + r.slice(1).join(' · ') : ''}`);
    if (s.more > 0) out.push(moreInDashboard(s.more));
  }
  if (m.more > 0) out.push('', moreInDashboard(m.more));
  if (link && m.link) out.push('', `${m.link.label}: ${link}`);
  out.push('', '—', ...(m.footer ? [m.footer] : []), emailReason(look.channelName));
  return out.join('\n') + '\n';
}

export function renderEmail(full: MessageModel, look: EmailLook): RenderedEmail {
  const model = trimModel(full, EMAIL_LIMITS);
  const link = safeLink(model.link?.url);
  // The text part's newlines become CRLF in the MIME layer's base64; nothing here is a header but the subject.
  const text = textOf(model, look, link).replace(/\n/g, '\r\n');
  const html = htmlOf(model, look, link);
  return { subject: model.title, text, html, model, bytes: Buffer.byteLength(text) + Buffer.byteLength(html), notes: [] };
}
