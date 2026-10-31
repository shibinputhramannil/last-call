// Runs before the game's modules, as a plain deferred script. It switches on
// the web fonts without letting them hold up the first paint, and if the game
// never starts (a module failed to download, or threw while starting), it says
// so on the loading screen and offers a reload instead of leaving it blank.

{
  const root = document.documentElement;

  const fonts = document.getElementById('font-css');
  if (fonts) {
    const on = () => {
      fonts.media = 'all';
    };
    if (fonts.sheet) on();
    else fonts.addEventListener('load', on);
  }

  const stuck = (message) => {
    if (root.dataset.booted) return;
    const screen = document.getElementById('screen-connect');
    const detail = document.getElementById('connect-detail');
    if (!screen || !detail) return;
    for (const id of ['screen-story', 'shell']) document.getElementById(id)?.setAttribute('hidden', '');
    screen.hidden = false;
    screen.classList.add('is-stuck');
    detail.textContent = message;
    document.getElementById('connect-reload')?.classList.add('is-shown');
  };

  // A module that failed to download fires "error" on its script element (caught
  // here in the capture phase); an exception while starting up reaches window.
  window.addEventListener(
    'error',
    (e) => {
      if (e.target instanceof HTMLScriptElement || e instanceof ErrorEvent) {
        stuck('Last Call could not finish loading. Check your internet connection, then reload the page.');
      }
    },
    true,
  );
  setTimeout(() => stuck('This is taking longer than usual. Your connection may be slow: give it a moment, or reload the page.'), 15_000);
}
