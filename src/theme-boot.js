/* Aplica el último tema antes de pintar la página, para que no parpadee al abrir. */
(function () {
  var eff = 'dark';
  try {
    var t = JSON.parse(localStorage.getItem('reprochip.theme') || 'null');
    if (t) eff = t.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t.theme === 'light' ? 'light' : 'dark';
  } catch (_) {}
  document.documentElement.dataset.theme = eff;
})();
