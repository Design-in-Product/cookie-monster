// Banner Scout — Global Privacy Control (client-side signal)
//
// Runs in the MAIN world at document_start so page scripts see
// navigator.globalPrivacyControl === true before they check it. This is the
// JavaScript-visible half of GPC; the HTTP Sec-GPC header (the half with
// legal force under CCPA/CPRA and similar) is set separately via the
// declarativeNetRequest ruleset in rules.json.
//
// GPC is an affirmative "do not sell/share" opt-out. It fits Banner Scout's
// stance exactly: we never consent, and now we say so in the standard way.

(() => {
  'use strict';
  try {
    if (navigator.globalPrivacyControl === true) return;
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
      get: () => true,
      configurable: true,
      enumerable: true,
    });
  } catch (e) {
    // A page may have already locked the property; nothing more we can do.
  }
})();
