/**
 * open-in-tab.js — the bridge that toggles the MAIN-world patch
 * (open-in-tab-main.js).
 *
 * A patch living in the MAIN world cannot read chrome.storage, so the setting
 * (`openFormsInTab`, default true) is read here, in the isolated world, and
 * handed over through an attribute on documentElement. The patch reads it at
 * call time, so the toggle takes effect without reloading the page.
 */
(function () {
  'use strict';

  function apply(enabled) {
    document.documentElement.setAttribute('data-scribe-open-in-tab', enabled ? '1' : '0');
  }

  try {
    chrome.storage.local.get({ openFormsInTab: true }, (s) => apply(s.openFormsInTab !== false));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'openFormsInTab' in changes) {
        apply(changes.openFormsInTab.newValue !== false);
      }
    });
  } catch (_) {
    apply(true); // default — on
  }
})();
