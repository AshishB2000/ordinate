'use strict';

// INTERFACE LANGUAGES — the hub's `t()`. Classic global-scope script, loaded
// FIRST among the hub's own scripts, right after the shared formatter
// src/app/i18nCore.js and its two-line shim (see cjsShim.ts): every later
// script may call t() at load time.
//
// The catalog arrives synchronously from the preload (`window.hubI18n.boot`):
// the chosen locale's messages plus English, which is the fallback for every
// key a draft locale lacks. Those are counted, and in a dev build reported once
// as a console warning. Changing the language reloads the window (Settings →
// General → Language), so nothing here re-renders.
//
// index.html's static text carries `data-i18n="key"` (text) and
// `data-i18n-<attr>="key"` (title, placeholder, aria-label, alt) — written by
// scripts/i18n-extract.ts — and is translated once, below, before any other
// script reads or clones it. `<template>` contents included.

// ponytail: the CommonJS exports of src/app/i18nCore.js, typed there, not re-declared here
const I18N_CORE: any = (window as any).module.exports;
delete (window as any).module;
delete (window as any).exports;

// ponytail: the preload's boot payload is JSON shaped by src/app/i18n.ts bootPayload()
const I18N_BOOT: any = ((window as any).hubI18n && (window as any).hubI18n.boot) || {
  locale: 'en', messages: {}, fallback: {}, languages: [], dev: false,
};

const I18N_LOCALE: string = String(I18N_BOOT.locale || 'en');

const i18nTr = I18N_CORE.createTranslator({
  locale: I18N_LOCALE,
  messages: I18N_BOOT.messages || {},
  fallback: I18N_BOOT.fallback || {},
});

/** Translate a catalog key. Params are already-formatted values (format.ts). */
function t(key: string, params?: Record<string, unknown>): string {
  return i18nTr(key, params);
}

/** Keys the current locale lacked so far (they showed in English). */
function i18nMissingCount(): number {
  return i18nTr.missing.size;
}

/** Translate every tagged element under `root` (and inside its templates). */
function i18nApplyDom(root: ParentNode): void {
  const visit = (scope: ParentNode): void => {
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
      scope.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
        const key = el.getAttribute(`data-i18n-${attr}`);
        if (key) el.setAttribute(attr, t(key));
      });
    }
    scope.querySelectorAll('template').forEach((tpl) => visit((tpl as HTMLTemplateElement).content));
  };
  visit(root);
}

(function i18nInit(): void {
  document.documentElement.lang = I18N_LOCALE === 'en-XA' ? 'en' : I18N_LOCALE;
  if (I18N_LOCALE !== 'en') i18nApplyDom(document);
  if (I18N_BOOT.dev && I18N_LOCALE !== 'en' && I18N_LOCALE !== 'en-XA') {
    // After the first screen is built — later lookups are counted, not re-reported.
    setTimeout(() => {
      const n = i18nMissingCount();
      if (n) console.warn(`[i18n] ${n} key${n === 1 ? '' : 's'} missing in ${I18N_LOCALE}; shown in English`);
    }, 4000);
  }
})();
