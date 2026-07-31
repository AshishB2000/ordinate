const hotkeyEl = document.getElementById('hotkey')!;
const noteEl = document.getElementById('note')!;

window.screenchart.onState((data) => {
  // Render the hotkey as a <kbd> chip without using innerHTML on raw input.
  hotkeyEl.textContent = '';
  const kbd = document.createElement('kbd');
  kbd.textContent = data.hotkey;
  hotkeyEl.appendChild(kbd);

  noteEl.textContent = data.note || '';
});

document.getElementById('open-hub')!.addEventListener('click', () => {
  window.screenchart.openHub();
});
