// The renderer's global `t()` for self-checks that run renderer scripts in a
// node `vm` sandbox: English, from the same catalog and the same formatter the
// hub binds (renderer/hub/i18n.ts), so a label asserted here is the label shown.

import { createTranslator, messagesOf } from '../src/app/i18nCore';

const en = messagesOf(require('../src/i18n/en.json'));

export const englishT = createTranslator({ locale: 'en', messages: {}, fallback: en });

/** Give a vm sandbox the hub's `t()` (and return it, for `vm.createContext(withT({…}))`). */
export function withT<T extends object>(sandbox: T): T {
  (sandbox as Record<string, unknown>).t = englishT;
  return sandbox;
}
