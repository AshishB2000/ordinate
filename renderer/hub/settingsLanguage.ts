'use strict';

// Settings → General → LANGUAGE: the interface language. Classic global-scope
// script: no import/export. Loads after settingsFormats.js, whose row builders
// (sfRow, sfEl) it reuses, and sits FIRST in General — above Formats, which it
// is easily confused with (Formats decides how figures are written; this
// decides the words around them).
//
// The list comes from main (src/app/i18n.ts): English is complete; drafts are
// marked "(beta)"; the pseudo-locale is for testing layouts. Changing it saves
// to config and reloads the window, because every label was built at load time.

function langOptionLabel(l: { name: string; status: string }): string {
  if (l.status === 'draft') return `${l.name} (beta)`;
  if (l.status === 'testing') return t('settingsLanguage.for_testing', { name: l.name });
  return l.name;
}

function buildLanguageSection(host: HTMLElement): void {
  const head = sfEl('div', 'stp-subhead');
  head.appendChild(sfEl('div', 'stp-subhead-t', t('settingsLanguage.language')));
  head.appendChild(sfEl('div', 'stp-subhead-d',
    t('settingsLanguage.the_language_of_menus_labels_and')));
  host.appendChild(head);

  const sel = sfEl<HTMLSelectElement>('select', 'stp-input stp-select lang-select');
  sel.id = 'stp-language';
  sel.setAttribute('aria-label', t('settingsLanguage.interface_language'));
  const langs: { code: string; name: string; status: string }[] = (I18N_BOOT.languages || []);
  for (const l of langs) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = langOptionLabel(l);
    if (l.code === I18N_LOCALE) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', async () => {
    const code = sel.value;
    const res = await window.hubI18n.setLanguage(code);
    if (res && res.ok) location.reload();
    else showToast((res && res.error) || t('settingsLanguage.could_not_change_the_language'));
  });
  const note = t('settingsLanguage.translations_marked_beta_are_drafts');
  host.appendChild(sfRow(t('settingsLanguage.interface_language'), note, sel));
}

(function initSettingsLanguage(): void {
  const formats = document.getElementById('stp-formats');
  if (!formats || !formats.parentElement || !window.hubI18n) return;
  const host = sfEl('div', 'stp-group');
  host.id = 'stp-language-group';
  formats.parentElement.insertBefore(host, formats);
  buildLanguageSection(host);
})();
