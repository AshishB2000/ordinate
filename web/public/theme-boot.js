// Runs before first paint (see index.html). Mirrors resolveTheme() in
// src/app/theme.ts — the key and values must stay in step with it.
{
  let pref = 'system';
  try {
    pref = localStorage.getItem('ordinate.theme') || 'system';
  } catch (_) {
    // storage blocked: follow the system
  }
  const dark = pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
