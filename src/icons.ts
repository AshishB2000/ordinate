import * as fs from 'fs';
import * as path from 'path';

// Provider brand logos, resolved in the MAIN process (the hub preload is
// sandboxed and can't require() simple-icons). ONE shared providerId → icon map,
// shipped to every surface so popups + settings agree.
//
// Resolution is DETERMINISTIC: each providerId maps to a SPECIFIC simple-icons
// EXPORT NAME (e.g. siGooglegemini) — no runtime slug-guessing, which is what
// kept breaking. A providerId not listed here, or whose export is absent in the
// installed simple-icons version, has NO real mark → the renderer draws a styled
// brand badge. Verified against the installed version via `npm run icons:verify`
// (see scripts/verify-icons.js). All bundled — no network, fully offline.
export const PROVIDER_SI: Record<string, string> = {
  anthropic:  'siClaude',         // BYOK "Claude" provider — Claude mark
  claude:     'siClaudecode',     // Claude Code CLI — Claude Code mark
  gemini:     'siGooglegemini',   // BYOK Gemini + Gemini CLI
  opencode:   'siOpencode',
  ollama:     'siOllama',
  openrouter: 'siOpenrouter',
  // NO simple-icon in this version → styled badge: openai, codex (OpenAI),
  // gateway (generic), grok (xAI), antigravity (Google).
};

// Relative luminance (WCAG) of a 6-hex color, 0 (black) … 1 (white).
export function relLuminance(hex: string): number {
  const n = parseInt(hex, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

// Brand color when it stays legible on BOTH light and dark themes; otherwise
// 'currentColor' so near-black/near-white marks adapt to the theme text color
// instead of vanishing (the dark/light contrast safeguard). Thresholds are tight
// so only genuinely near-mono marks (e.g. #000 OpenCode/Ollama) fall back — a
// legible mid-tone like Gemini's #8E75B2 keeps its brand color.
export function safeColor(hex: string): string {
  const L = relLuminance(hex);
  return (L < 0.10 || L > 0.90) ? 'currentColor' : '#' + hex;
}

// providerId → { path, color, title, export } for providers with a real icon.
export const providerLogos = (() => {
  const out: Record<string, { path: string; color: string; title: string; export: string }> = {};
  try {
    // ponytail: optional dep, indexed by dynamic export name — any is fine here
    const si: any = require('simple-icons');
    for (const [id, name] of Object.entries(PROVIDER_SI)) {
      const ic = si[name];
      if (ic && ic.path) out[id] = { path: ic.path, color: safeColor(ic.hex), title: ic.title, export: name };
    }
  } catch (_) { /* icons optional — renderer falls back to badges */ }
  return out;
})();

// Full-color agent logos that don't fit the single-path simple-icons model
// (e.g. Antigravity's gradient mark). Drop a file named <agentId>.svg (preferred)
// or <agentId>.png into renderer/hub/assets/agents/ and it's auto-discovered:
// MAIN reads it and ships a data-URI the renderer renders as an <img> (CSP allows
// img-src data:). When no file exists, the renderer falls back to the styled badge.
const AGENT_DIR = path.join(__dirname, '..', 'renderer', 'hub', 'assets', 'agents');

export const agentLogos = (() => {
  const out: Record<string, string> = {};
  try {
    for (const f of fs.readdirSync(AGENT_DIR)) {
      const m = /^(.+)\.(svg|png)$/i.exec(f);
      if (!m) continue;
      const buf = fs.readFileSync(path.join(AGENT_DIR, f));
      const mime = m[2].toLowerCase() === 'svg' ? 'image/svg+xml' : 'image/png';
      out[m[1].toLowerCase()] = `data:${mime};base64,` + buf.toString('base64');
    }
  } catch (_) { /* dir optional — fall back to badges */ }
  return out;
})();
