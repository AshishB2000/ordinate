'use strict';

// Settings → Automation. Classic global-scope renderer <script>: no
// import/export. Builds into #stp-automation (index.html) with the panel's own
// row helpers (settingsFormats.ts sfEl / sfRow).
//
// Everything painted comes from main (`automation:status`); every switch
// writes through main (`automation:set`) and repaints from its answer, so the
// pane never shows a state the server is not in.
//
// THE TOKEN is taken from main at most once per issue (`automation:takeToken`
// hands it out a single time), and only while this pane is on screen. It stays
// visible until the pane is left, then only the mask remains — there is no way
// back to it except Regenerate.

let amStatus: any = null;
let amFreshToken = '';
let amPortDraft = '';
let amBusy = false;

function amSwitch(id: string, label: string, on: boolean, onToggle: () => void): HTMLButtonElement {
  const b = sfEl<HTMLButtonElement>('button', 'stp-switch' + (on ? ' stp-switch-on' : ''));
  b.id = id;
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', on ? 'true' : 'false');
  b.setAttribute('aria-label', label);
  b.appendChild(sfEl('span', 'stp-switch-thumb'));
  b.addEventListener('click', onToggle);
  return b;
}

function amCopyButton(text: () => string, label = t('common.copy')): HTMLButtonElement {
  const b = sfEl<HTMLButtonElement>('button', 'btn btn-sm am-copy');
  b.type = 'button';
  b.append(icon('copy', 14), document.createTextNode(label));
  b.addEventListener('click', () => {
    window.hub.copyText(text());
    b.classList.add('is-done');
    b.lastChild!.textContent = t('settingsAutomation.copied');
    setTimeout(() => { b.classList.remove('is-done'); b.lastChild!.textContent = label; }, 1600);
  });
  return b;
}

/** A command the user pastes somewhere: monospace, selectable, one Copy. */
function amCode(text: string, id?: string): HTMLElement {
  const box = sfEl('div', 'am-code');
  const pre = sfEl('code', 'am-code-text', text);
  if (id) pre.id = id;
  box.append(pre, amCopyButton(() => text));
  return box;
}

function amSubhead(title: string, desc?: string): HTMLElement {
  const h = sfEl('div', 'stp-subhead');
  h.appendChild(sfEl('div', 'stp-subhead-t', title));
  if (desc) h.appendChild(sfEl('div', 'stp-subhead-d', desc));
  return h;
}

async function amSet(patch: { enabled?: boolean; http?: boolean; port?: number }): Promise<void> {
  if (amBusy) return;
  amBusy = true;
  try {
    const res = await window.hubAutomation.set(patch);
    if (res && res.ok === false && res.message) showToast(res.message, { kind: 'error' });
    amStatus = res;
    if (patch.port !== undefined && res && res.ok !== false) amPortDraft = '';
    await amTakeToken();
  } finally {
    amBusy = false;
  }
  amPaint();
}

/** Take a freshly issued token — only while the pane is visible, so it is SEEN once. */
async function amTakeToken(): Promise<void> {
  const pane = document.getElementById('stp-automation');
  if (!pane || !pane.offsetParent || !amStatus || !amStatus.token || !amStatus.token.fresh) return;
  const res = await window.hubAutomation.takeToken();
  if (res && res.token) amFreshToken = res.token;
}

function amTokenRow(): HTMLElement {
  const s = amStatus;
  if (amFreshToken) {
    const box = sfEl('div', 'am-token am-token-fresh');
    const code = sfEl('code', 'am-token-value', amFreshToken);
    code.id = 'am-token-value';
    box.append(code, amCopyButton(() => amFreshToken));
    const wrap = sfEl('div', 'am-token-wrap');
    wrap.append(box, sfEl('div', 'am-note am-note-warn',
      t('settingsAutomation.shown_once_copy_it_now_it')));
    return sfRow(t('settingsAutomation.access_token'), t('settingsAutomation.tools_send_it_as_a_bearer'), wrap);
  }
  const masked = sfEl('code', 'am-token-value am-token-masked', s.token.exists ? s.token.masked : t('settingsAutomation.not_issued_yet'));
  masked.id = 'am-token-value';
  const regen = sfEl<HTMLButtonElement>('button', 'btn btn-sm', t('common.regenerate'));
  regen.type = 'button';
  regen.id = 'am-token-regen';
  regen.disabled = !s.running;
  regen.addEventListener('click', async () => {
    amStatus = await window.hubAutomation.regenerateToken();
    await amTakeToken();
    amPaint();
  });
  return sfRow(t('settingsAutomation.access_token'),
    t('settingsAutomation.hidden_after_it_was_shown_regenerate'),
    masked, regen);
}

function amHttpSection(host: HTMLElement): void {
  const s = amStatus;
  host.appendChild(amSubhead(t('settingsAutomation.local_http_server'),
    t('settingsAutomation.for_tools_that_connect_by_url')));
  const group = sfEl('div', 'stp-group');
  group.appendChild(sfRow(t('settingsAutomation.serve_over_http'), t('settingsAutomation.a_second_switch_off_by_default'),
    amSwitch('am-http', t('settingsAutomation.serve_mcp_over_local_http'), s.http, () => void amSet({ http: !s.http }))));
  if (s.http) {
    const pill = sfEl('span', 'am-pill ' + (s.running ? 'is-on' : s.error ? 'is-err' : 'is-off'));
    pill.id = 'am-http-state';
    pill.appendChild(sfEl('span', 'am-dot'));
    pill.appendChild(document.createTextNode(s.running ? t('settingsAutomation.listening') : s.error ? t('settingsAutomation.not_running') : t('settingsAutomation.stopped')));
    const port = sfEl<HTMLInputElement>('input', 'stp-input am-port');
    port.id = 'am-port';
    port.type = 'number';
    port.min = '1024';
    port.max = '65535';
    port.value = amPortDraft || String(s.port);
    port.setAttribute('aria-label', t('common.port'));
    const apply = sfEl<HTMLButtonElement>('button', 'btn btn-sm', t('common.apply'));
    apply.type = 'button';
    apply.id = 'am-port-apply';
    apply.hidden = !amPortDraft || amPortDraft === String(s.port);
    port.addEventListener('input', () => { amPortDraft = port.value; apply.hidden = !port.value || port.value === String(s.port); });
    port.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply.click(); });
    apply.addEventListener('click', () => void amSet({ port: Number(port.value) }));
    const where = s.error ? s.error : s.running ? s.url : t('settingsAutomation.starts_when_you_apply_a_free');
    group.appendChild(sfRow(t('common.address'), where, pill, port, apply));
    group.appendChild(amTokenRow());
  }
  host.appendChild(group);
  if (s.http && s.running) {
    host.appendChild(sfEl('div', 'am-note', 'To add it to Claude Code by URL, run this with <token> replaced by the access token:'));
    host.appendChild(amCode(s.httpSetup));
  }
}

function amToolsSection(host: HTMLElement): void {
  const tools: any[] = Array.isArray(amStatus.tools) ? amStatus.tools : [];
  host.appendChild(amSubhead(t('settingsAutomation.what_a_connected_tool_can_do'),
    t('settingsAutomation.every_figure_is_computed_by_ordinate')));
  const box = sfEl('div', 'am-tools');
  const group = (title: string, hint: string, list: any[], kind: string): HTMLElement => {
    const g = sfEl('div', 'am-tools-group am-tools-' + kind);
    const head = sfEl('div', 'am-tools-head');
    head.append(icon(kind === 'read' ? 'eye' : 'plus', 14), sfEl('span', 'am-tools-title', title), sfEl('span', 'am-tools-hint', hint));
    const chips = sfEl('div', 'am-tools-chips');
    for (const t of list) {
      const chip = sfEl('code', 'am-chip', t.name);
      chip.title = t.summary; // the registry's own one-liner
      chips.appendChild(chip);
    }
    g.append(head, chips);
    return g;
  };
  box.append(
    group(t('settingsAutomation.read'), t('settingsAutomation.look_compute_and_export_nothing_in'), tools.filter((t) => t.readOnly), 'read'),
    group(t('common.create'), t('settingsAutomation.save_a_new_visual_or_dashboard'), tools.filter((t) => !t.readOnly), 'write'),
  );
  host.appendChild(box);
}

function amPaint(): void {
  const host = document.getElementById('stp-automation');
  if (!host || !amStatus) return;
  const s = amStatus;
  host.textContent = '';

  const master = sfEl('div', 'stp-group');
  master.appendChild(sfRow(t('settingsAutomation.allow_tools_to_connect'),
    t('settingsAutomation.runs_a_local_mcp_server_so'),
    amSwitch('am-enabled', t('settingsAutomation.allow_tools_like_claude_code_to'), s.enabled, () => void amSet({ enabled: !s.enabled }))));
  host.appendChild(master);

  if (!s.enabled) {
    const off = sfEl('div', 'am-off');
    off.id = 'am-off';
    const ic = sfEl('div', 'am-off-ic');
    ic.appendChild(icon('shield', 20));
    const text = sfEl('div', 'am-off-text');
    text.append(sfEl('div', 'am-off-t', t('settingsAutomation.no_tool_can_connect')),
      sfEl('div', 'am-off-d', t('settingsAutomation.the_mcp_server_is_off_so')));
    off.append(ic, text);
    host.appendChild(off);
  } else {
    host.appendChild(amSubhead(t('settingsAutomation.connect_claude_code'),
      t('settingsAutomation.claude_code_starts_ordinate_in_the')));
    host.appendChild(amCode(s.stdioSetup, 'am-stdio-cmd'));
    amHttpSection(host);
    amToolsSection(host);
  }

  host.appendChild(amSubhead(t('settingsAutomation.command_line'),
    t('settingsAutomation.script_ordinate_from_any_terminal_always')));
  host.appendChild(amCode(s.cliExample, 'am-cli-cmd'));
  host.appendChild(sfEl('div', 'am-note', t('settingsAutomation.add_cli_help_for_every_command')));
}

async function amRefresh(): Promise<void> {
  try {
    amStatus = await window.hubAutomation.status();
    await amTakeToken();
  } catch (_) {
    return;
  }
  amPaint();
}

(function initSettingsAutomation(): void {
  const host = document.getElementById('stp-automation');
  const pane = host && host.closest('.settings-pane');
  if (!host || !pane || !window.hubAutomation) return;
  // The pane is on screen when its category is selected (selectSettingsCat
  // flips `hidden`) AND the Settings panel is open (its inline display).
  // Arriving is the moment to read the state; leaving is when a shown token goes.
  let shown = false;
  const sync = (): void => {
    const now = !!(host as HTMLElement).offsetParent;
    if (now === shown) return;
    shown = now;
    if (now) { void amRefresh(); return; }
    amFreshToken = '';
    amPortDraft = '';
    if (amStatus) amPaint();
  };
  const watch = new MutationObserver(sync);
  watch.observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  const panel = document.getElementById('settings-panel');
  if (panel) watch.observe(panel, { attributes: true, attributeFilter: ['style'] });
})();
