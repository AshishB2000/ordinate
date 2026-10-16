// The page an embed shows when it cannot show the dashboard — inside the
// host's iframe when the token's signature held (the host should see why),
// framable by nobody otherwise. No script; one stylesheet pinned by hash.

import { createHash } from 'crypto';
import { embedRefusedTitle } from '../embedMessages';

const CSS = `
  :root { color-scheme: light dark; --bg: #f7f8fa; --fg: #1f2430; --muted: #5b6475; --line: #dfe3ea; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14171d; --fg: #e8ebf0; --muted: #9aa3b2; --line: #2a303a; } }
  html, body { margin: 0; height: 100%; }
  body { display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--fg);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .box { max-width: 420px; margin: 24px; padding: 20px 24px; border: 1px solid var(--line); border-radius: 12px; text-align: center; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0; color: var(--muted); }
`;

const STYLE_HASH = "'sha256-" + createHash('sha256').update(CSS, 'utf8').digest('base64') + "'";

/** The refusal page's CSP; `ancestors` = who may frame it ('none' when the signature did not hold). */
export function refusalCsp(ancestors: readonly string[]): string {
  return `default-src 'none'; style-src ${STYLE_HASH}; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors.length ? ancestors.join(' ') : "'none'"}`;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export function refusalHtml(message: string): string {
  const title = embedRefusedTitle();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="box" role="alert"><h1>${esc(title)}</h1><p>${esc(message)}</p></div></body></html>`;
}
