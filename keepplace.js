// keepplace.js — remember which page you were on, so refreshing the dashboard puts you back there
// instead of on the Overview. It only remembers for the open browser tab (cleared when the tab is closed).
// It works by "pressing" the same menu button you pressed last time, once the menu has finished loading,
// so every page behaves exactly as if you had clicked it yourself.
(function () {
  'use strict';
  var KEY = 'atamgo_last_page';

  function read() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { sessionStorage.setItem(KEY, v); } catch (e) { /* private window etc: just forget it */ } }

  // Remember every menu click (capture phase so it happens whatever the page's own code does).
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.nav-link') : null;
    if (b && b.dataset && b.dataset.page) write(b.dataset.page);
  }, true);

  var want = read();
  if (!want || want === 'overview') return;

  function restore() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var btn = document.querySelector('.nav-link[data-page="' + want + '"]');
      if (btn) {
        clearInterval(timer);
        btn.click();
      } else if (tries > 80) {      // about 20 seconds: that page no longer exists, stay on the Overview
        clearInterval(timer);
      }
    }, 250);
  }

  // Wait until the page and the dashboard's own scripts have started, so the menu is wired up.
  if (document.readyState === 'complete') restore();
  else window.addEventListener('load', restore);
})();
