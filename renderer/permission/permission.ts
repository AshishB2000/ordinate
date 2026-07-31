document.getElementById('open-settings-btn')!.addEventListener('click', () => {
  window.permission.openSettings();
});

document.getElementById('done-btn')!.addEventListener('click', () => {
  window.permission.done();
});
