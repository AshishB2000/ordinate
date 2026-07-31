// Verify provider logos against the INSTALLED simple-icons version.
// Prints, for every providerId the UI can render, whether it resolves to a real
// simple-icons export (and in which brand color) or falls back to a styled badge.
// Run: npm run icons:verify
//
// This reads the SAME mapping the app ships (src/icons.js), so what you see here
// is exactly what renders — no guessing.

import { providerLogos, PROVIDER_SI } from '../src/icons';

// Every providerId a logo may be drawn for (BYOK providers + local CLIs).
const ALL = [
  'anthropic', 'claude', 'gemini', 'openai', 'codex', 'gateway',
  'grok', 'antigravity', 'opencode', 'cursor', 'ollama', 'openrouter',
];

let real = 0, badge = 0;
console.log('providerId        resolution');
console.log('----------------  ------------------------------------------------------');
for (const id of ALL) {
  const logo = providerLogos[id];
  if (logo) {
    real++;
    console.log(id.padEnd(16), ` REAL  ${logo.export.padEnd(16)} color=${String(logo.color).padEnd(11)} (${logo.title})`);
  } else if (PROVIDER_SI[id]) {
    badge++;
    console.log(id.padEnd(16), ` BADGE — mapped export ${PROVIDER_SI[id]} MISSING in installed simple-icons`);
  } else {
    badge++;
    console.log(id.padEnd(16), ' BADGE — no simple-icon mark in this version (styled brand badge)');
  }
}
console.log('----------------  ------------------------------------------------------');
console.log(`${real} real icon(s), ${badge} styled badge(s).`);
