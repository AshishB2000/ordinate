// Runs before first paint (see index.html). Mirrors resolveTheme() and the
// canvas / highlight preferences in src/app/theme.ts — the keys and values
// must stay in step with it.
{
  const root = document.documentElement;
  let pref = 'system';
  let canvas = '';
  let accent = '';
  try {
    pref = localStorage.getItem('ordinate.theme') || 'system';
    canvas = localStorage.getItem('ordinate.canvas') || '';
    accent = localStorage.getItem('ordinate.accent') || '';
  } catch (_) {
    // storage blocked: follow the system, on the default canvas and accent
  }
  const dark = pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  // An id appearance.css does not know matches no rule, so the defaults show.
  if (/^[a-z]{1,16}$/.test(canvas) && canvas !== 'slate') root.dataset.canvas = canvas;
  if (/^[a-z]{1,16}$/.test(accent)) root.dataset.accent = accent;
}
