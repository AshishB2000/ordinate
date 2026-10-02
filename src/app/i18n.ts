// INTERFACE LANGUAGES — main's half. The catalogs are renderer/i18n/<code>.json
// (en is built by scripts/i18n-extract.ts; es/de/fr/ja are drafts marked
// `"_status": "draft"`); the formatter is i18nCore.ts, shared with the renderer.
//
// The chosen language is `language` in config.json. Main uses it for the text
// IT writes — captions, insight and alert sentences, report text — and for one
// line in the Assistant's system prompt. The renderer gets the whole catalog at
// boot, synchronously (src/ipc/i18n.ts → preload/hubLanguagePreload.ts), because
// renderer scripts build labels at load time.
//
// Figures never pass through a translation: callers format numbers with
// format.ts first and hand t() the finished string.

import { createTranslator, messagesOf, PSEUDO_LOCALE } from './i18nCore';
import type { Catalog, Params, Translator } from './i18nCore';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const DIR = path.join(__dirname, '..', '..', 'renderer', 'i18n');

export interface LanguageInfo {
  code: string;
  /** The language's name in itself — what a reader of it looks for. */
  name: string;
  /** 'complete' | 'draft' | 'testing' */
  status: string;
}

/** Shipped languages, in the order Settings lists them. */
const LANGS: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'ja', name: '日本語' },
  { code: PSEUDO_LOCALE, name: 'Pseudo (en-XA)' },
];

/** English names, for the one line the Assistant reads. */
const ENGLISH_NAME: Record<string, string> = { en: 'English', es: 'Spanish', de: 'German', fr: 'French', ja: 'Japanese' };

const files = new Map<string, Record<string, unknown>>();

function readFile(code: string): Record<string, unknown> {
  const hit = files.get(code);
  if (hit) return hit;
  let data: Record<string, unknown> = {};
  if (code !== PSEUDO_LOCALE) {
    try { data = JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8')); } catch (_) { data = {}; }
  }
  files.set(code, data);
  return data;
}

export function isLanguage(code: unknown): code is string {
  return typeof code === 'string' && LANGS.some((l) => l.code === code);
}

export function languages(): LanguageInfo[] {
  return LANGS.map((l) => {
    if (l.code === PSEUDO_LOCALE) return { ...l, status: 'testing' };
    const st = readFile(l.code)._status;
    return { ...l, status: typeof st === 'string' ? st : 'complete' };
  });
}

let current = 'en';
let tr: Translator | null = null;

/** Set from config at startup and whenever Settings changes it. */
export function setLanguage(code: unknown): string {
  const next = isLanguage(code) ? code : 'en';
  if (next !== current || !tr) { current = next; tr = null; }
  return current;
}

export function currentLanguage(): string {
  return current;
}

export function catalog(code: string): Catalog {
  return messagesOf(readFile(code));
}

function translator(): Translator {
  if (!tr) {
    tr = createTranslator({
      locale: current,
      messages: current === 'en' ? {} : catalog(current),
      fallback: catalog('en'),
    });
  }
  return tr;
}

/** Main's t(): the same keys and the same catalog as the renderer's. */
export function t(key: string, params?: Params): string {
  return translator()(key, params);
}

/** What the renderer needs before its first script runs. */
export function bootPayload(): { locale: string; messages: Catalog; fallback: Catalog; languages: LanguageInfo[] } {
  return {
    locale: current,
    messages: current === 'en' || current === PSEUDO_LOCALE ? {} : catalog(current),
    fallback: catalog('en'),
    languages: languages(),
  };
}

/**
 * The Assistant's language line. Empty in English (and the pseudo-locale), so
 * an English prompt is byte-for-byte what it was. The facts stay numbers: the
 * model is told to copy every figure as given, never to convert or recompute it.
 */
export function languageInstruction(code = current): string {
  const name = ENGLISH_NAME[code];
  if (!name || code === 'en') return '';
  return `--- Language ---\nWrite all prose for the reader in ${name}. Keep every number, figure, date, `
    + 'column name and dataset name exactly as given — copy them; never convert, reformat or recompute them. '
    + 'When the reply is JSON, its keys, ids, column names and enumerated values stay exactly as specified; '
    + `only free-text fields are written in ${name}.`;
}

/** A system prompt with the language line appended — unchanged in English. */
export function withLanguage(systemPrompt: string): string {
  const line = languageInstruction();
  return line ? `${systemPrompt}\n\n${line}` : systemPrompt;
}
