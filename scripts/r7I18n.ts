// Round 7 smoke SECTION: interface languages, driven through the REAL UI. Not a
// standalone smoke — scripts/smoke-round7.ts calls i18nSection(s, fx) on its one
// launch and fixture.
//
//   Settings → General lists English first, the four drafts as "(beta)" and the
//   pseudo-locale → choosing Español through the real <select> saves and reloads
//   the window → <html lang> is es, static index.html text (data-i18n) and
//   script-built labels both read in Spanish, straight from es.json, and no key
//   fell back to English → main's sentences (captions, alerts) and the
//   Assistant's system prompt follow the language, the prompt's English text
//   untouched and the figures still the app's → en-XA accents everything and
//   is longer → back to English, byte-for-byte the labels it started with.
//   Leaves the app in English with the project's Data list on screen.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject } from './smokeFixture';

type Win = Smoke['win'];
declare const showSettingsPanel: (cat?: string) => Promise<void>;
declare function i18nMissingCount(): number;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return true;
    await win.waitForTimeout(150);
  }
  return false;
}

/** Choose a language the way a person does, and wait out the reload it causes. */
async function choose(s: Smoke, code: string): Promise<boolean> {
  const { win } = s;
  await win.evaluate(() => { void showSettingsPanel('general'); });
  const shown = await until(win, () => win.evaluate(() => !!document.getElementById('stp-language')));
  if (!shown) return false;
  await win.evaluate((c: string) => {
    const sel = document.getElementById('stp-language') as HTMLSelectElement;
    sel.value = c;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, code);
  const want = code === 'en-XA' ? 'en' : code;
  await until(win, () => win.evaluate(() => document.readyState === 'loading').catch(() => true), 5_000);
  const reloaded = await until(win, () => win.evaluate((w: string) =>
    document.documentElement.lang === w && typeof (window as any).hubI18n === 'object'
      && (window as any).hubI18n.boot && (window as any).hubI18n.boot.locale !== undefined, want), 30_000);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(2500);
  await s.killSplash();
  return reloaded;
}

/** The first few visible elements tagged data-i18n: key and the text they show. */
const taggedSample = (win: Win): Promise<{ key: string; text: string }[]> =>
  win.evaluate(() => [...document.querySelectorAll('[data-i18n]')]
    .filter((el) => (el as HTMLElement).getClientRects().length > 0)
    .slice(0, 12)
    .map((el) => ({ key: el.getAttribute('data-i18n') || '', text: (el.textContent || '').trim() })));

export async function i18nSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  await openProject(win, fx.projectId);
  const enSample = await taggedSample(win);
  ok('i18n: the hub shows tagged static text in English', enSample.length > 3, JSON.stringify(enSample.slice(0, 3)));

  // ── Settings → General → Language ───────────────────────────────────────────
  await win.evaluate(() => { void showSettingsPanel('general'); });
  await until(win, () => win.evaluate(() => !!document.getElementById('stp-language')));
  const opts = await win.evaluate(() => [...(document.getElementById('stp-language') as HTMLSelectElement).options]
    .map((o) => ({ v: o.value, t: o.textContent || '' })));
  ok('i18n: Language lists English first', opts.length > 0 && opts[0].v === 'en' && opts[0].t === 'English', JSON.stringify(opts));
  ok('i18n: the four drafts are marked (beta)', ['es', 'de', 'fr', 'ja'].every((c) => opts.some((o) => o.v === c && /\(beta\)/.test(o.t))), JSON.stringify(opts));
  ok('i18n: the pseudo-locale is offered for testing', opts.some((o) => o.v === 'en-XA'));
  ok('i18n: Language sits above Formats', await win.evaluate(() => {
    const a = document.getElementById('stp-language-group');
    const b = document.getElementById('stp-formats');
    return !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));

  // ── Español ─────────────────────────────────────────────────────────────────
  ok('i18n: choosing Español saves and reloads the window', await choose(s, 'es'));
  await openProject(win, fx.projectId);
  const es = await win.evaluate(() => (window as any).hubI18n.boot.messages as Record<string, string>);
  const esSample = await taggedSample(win);
  const fromCatalog = esSample.filter((x) => typeof es[x.key] === 'string' && x.text === es[x.key].replace(/'([{}])'/g, '$1'));
  ok('i18n: static index.html text reads from es.json', fromCatalog.length >= Math.min(3, esSample.length),
    JSON.stringify(esSample.slice(0, 4)));
  ok('i18n: …and actually changed from the English', esSample.some((x) => enSample.some((y) => y.key === x.key && y.text !== x.text)));
  await win.evaluate(() => { void showSettingsPanel('general'); });
  await until(win, () => win.evaluate(() => !!document.getElementById('stp-language-group')));
  const head = await win.evaluate(() => (document.querySelector('#stp-language-group .stp-subhead-t')?.textContent || '').trim());
  ok('i18n: a script-built label is Spanish', head !== '' && head !== 'Language' && head === es['settingsLanguage.language'], head);
  ok('i18n: <html lang> is es', await win.evaluate(() => document.documentElement.lang === 'es'));
  ok('i18n: no key fell back to English on these screens', await win.evaluate(() => i18nMissingCount() === 0),
    String(await win.evaluate(() => i18nMissingCount())));

  // Main's half: its sentences, and the Assistant's prompt.
  const mainSide = await app.evaluate(() => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const i18n = req('./src/app/i18n.js');
    const alerts = req('./src/analysis/alerts.js');
    return {
      lang: i18n.currentLanguage(),
      caption: i18n.t('captions.no_data_to_summarize'),
      prompt: i18n.withLanguage('SYSTEM PROMPT'),
      digest: alerts.digestMessage([
        { ruleName: 'Ventas', message: 'x', firedAt: '2026-10-01T00:00:00Z' },
        { ruleName: 'Margen', message: 'y', firedAt: '2026-10-01T00:00:00Z' },
      ]),
    };
  });
  ok('i18n: main follows the language', mainSide.lang === 'es', mainSide.lang);
  ok('i18n: a caption from main is Spanish', mainSide.caption !== 'No data to summarize' && mainSide.caption.length > 3, mainSide.caption);
  ok('i18n: an alert digest from main is Spanish and keeps its names', /Ventas/.test(mainSide.digest) && !/alerts fired/.test(mainSide.digest), mainSide.digest);
  ok('i18n: the Assistant is told to answer in Spanish, figures untouched',
    mainSide.prompt.startsWith('SYSTEM PROMPT\n\n') && /Spanish/.test(mainSide.prompt) && /never convert, reformat or recompute/.test(mainSide.prompt),
    mainSide.prompt);

  // ── en-XA ───────────────────────────────────────────────────────────────────
  ok('i18n: choosing the pseudo-locale reloads', await choose(s, 'en-XA'));
  await openProject(win, fx.projectId);
  const xa = await taggedSample(win);
  ok('i18n: en-XA accents static text', xa.some((x) => /[àéîöûšţ]/.test(x.text)), JSON.stringify(xa.slice(0, 3)));
  ok('i18n: en-XA text is longer than the English', xa.every((x) => {
    const e = enSample.find((y) => y.key === x.key);
    return !e || x.text.length >= e.text.length;
  }));

  // ── Back to English ─────────────────────────────────────────────────────────
  ok('i18n: back to English', await choose(s, 'en'));
  await openProject(win, fx.projectId);
  const back = await taggedSample(win);
  ok('i18n: English labels are exactly what they were', back.every((x) => {
    const e = enSample.find((y) => y.key === x.key);
    return !e || e.text === x.text;
  }), JSON.stringify(back.slice(0, 3)));
  const mainBack = await app.evaluate(() => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const i18n = req('./src/app/i18n.js');
    return { lang: i18n.currentLanguage(), prompt: i18n.withLanguage('SYSTEM PROMPT') };
  });
  ok('i18n: in English the system prompt is unchanged', mainBack.lang === 'en' && mainBack.prompt === 'SYSTEM PROMPT');
  ok('i18n: no console errors in this section', s.errors.length === errors0, s.errors.slice(errors0).join('\n'));
}
