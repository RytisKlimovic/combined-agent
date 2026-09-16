/**
 * open-in-tab-main.js — opens EHR forms in a TAB instead of a popup window.
 *
 * Runs in the PAGE world (`world: "MAIN"`) because it has to replace the
 * `window.open` the host application itself calls — a content script in the
 * isolated world cannot reach that. Loaded at `document_start` so it is in
 * place before the host's own scripts run.
 *
 * Why: the host EHR opens its referral form in a popup window, and the Chrome
 * side panel DOES NOT WORK in popup windows. Opening the same URL as a tab in
 * a normal window makes the side panel work with no workarounds at all.
 *
 * Toggle: the isolated content/open-in-tab.js sets
 * documentElement[data-scribe-open-in-tab] from the user's preference; the
 * value is read here at CALL time, so the toggle applies immediately with no
 * reload.
 *
 * Safety valve: only LARGE popups (a whole form) are redirected. Small helper
 * windows (date pickers and the like) are left alone.
 */
(function () {
  'use strict';

  const orig = window.open;
  if (!orig || orig.__scribeWrapped) return;

  function isEnabled() {
    // Default is on: if the attribute is not there yet (the isolated script
    // has not run), fall back to the default setting.
    const v = document.documentElement.getAttribute('data-scribe-open-in-tab');
    return v === null ? true : v === '1';
  }

  function isLargePopup(features) {
    if (!features) return false;
    const w = parseInt((/\bwidth=(\d+)/i.exec(features) || [])[1] || '0', 10);
    const h = parseInt((/\bheight=(\d+)/i.exec(features) || [])[1] || '0', 10);
    return w >= 700 || h >= 500;
  }

  function wrapped(url, name, features) {
    try {
      if (isEnabled() && isLargePopup(features)) {
        // Without `features` the browser opens a TAB rather than a popup. The
        // name is kept so the host can reuse the same window and the
        // window.opener link keeps working.
        return orig.call(window, url, name || '_blank');
      }
    } catch (_) {
      /* any failure — fall back to the original behaviour */
    }
    return orig.apply(window, arguments);
  }

  wrapped.__scribeWrapped = true;
  try {
    window.open = wrapped;
  } catch (_) {
    /* some pages lock window.open down — then do nothing */
  }
})();
