'use strict';

// Settings → General → COLLABORATION: the name your comments are signed with.
// Classic global-scope script: no import/export. Loads after
// settingsFormats.js, whose row builders (sfRow, sfEl) it reuses so the row is
// the panel's own shape.
//
// The value lives in main (config.ts) and reaches this page only through
// publicConfig() (`getKeyStatus`); main resolves the author on every comment,
// so nothing typed here can sign someone else's. Comments sync with the
// project itself (src/app/comments.ts) — the row's note says where that is set.

function collabPaint(cfg: any): void {
  const name = document.getElementById('stp-display-name') as HTMLInputElement | null;
  if (name && document.activeElement !== name) name.value = (cfg && cfg.displayName) || '';
}

async function collabRefresh(): Promise<void> {
  try { collabPaint(await window.hub.getKeyStatus()); } catch (_) { /* keep what is shown */ }
}

function buildCollabSection(host: HTMLElement): void {
  const head = sfEl('div', 'stp-subhead');
  head.appendChild(sfEl('div', 'stp-subhead-t', t('settingsCollab.collaboration')));
  head.appendChild(sfEl('div', 'stp-subhead-d',
    t('settingsCollab.comments_are_signed_with_your_name')));
  host.appendChild(head);

  const name = sfEl<HTMLInputElement>('input', 'stp-input cmt-display-name');
  name.id = 'stp-display-name';
  name.type = 'text';
  name.maxLength = 80;
  name.placeholder = t('settingsCollab.your_computer_s_user_name');
  name.autocomplete = 'off';
  name.spellcheck = false;
  name.setAttribute('aria-label', t('common.display_name'));
  name.addEventListener('change', async () => {
    const res = await window.hubPower.setDisplayName(name.value);
    if (res && res.ok) showToast(t('settingsCollab.new_comments_are_signed', { author: res.author }));
  });
  host.appendChild(sfRow(t('common.display_name'), t('settingsCollab.on_every_comment_and_reply_you'), name));
}

(function initSettingsCollab(): void {
  const formats = document.getElementById('stp-formats');
  if (!formats || !formats.parentElement || !window.hubPower) return;
  const host = sfEl('div', 'stp-group');
  host.id = 'stp-collab';
  formats.parentElement.insertBefore(host, formats.nextSibling);
  buildCollabSection(host);
  void collabRefresh();
})();
