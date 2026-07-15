// Banner Scout — content script
//
// Model: hide, log, never consent. This script detects cookie-consent
// banners, hides them (no button is ever clicked, so no consent is ever
// given), and records every sighting to chrome.storage.local so the popup
// can report on how often banners actually appear.
//
// Detection is deliberately conservative. When a candidate looks banner-ish
// but risky to hide (login-like inputs, terms-of-service wording), it is
// logged but left visible — for a measurement tool, a logged false negative
// is cheap; a hidden false positive is not.

(() => {
  'use strict';

  // Top frame only. Iframe-based CMPs (e.g. Sourcepoint) are a known gap —
  // see README roadmap.
  if (window !== window.top) return;

  const MAX_LOG_ENTRIES = 1000;
  const MAX_CANDIDATES_PER_SCAN = 200;

  // Strong topic signals: a banner must mention one of these.
  const TOPIC_TERMS = [
    'cookies?', 'consent', 'gdpr', 'ccpa', 'trackers?', 'tracking',
    'datenschutz', 'confidentialité',
  ];

  // At least one action word must appear alongside a topic term.
  const ACTION_TERMS = [
    'accept', 'agree', 'allow', 'reject', 'decline', 'deny', 'got it',
    'preferences', 'manage', 'settings', 'options',
    'accepter', 'refuser', 'personnaliser',
    'aceptar', 'rechazar', 'personalizar',
    'akzeptieren', 'ablehnen', 'zustimmen', 'einstellungen',
    'accetta', 'rifiuta', 'personalizza',
  ];

  // Wording that suggests this dialog is about more than cookies. If it
  // matches and the text never says "cookie", log but do not hide.
  const RISKY_TERMS = [
    'terms of (?:service|use)', 'terms and conditions', 'sign in', 'log ?in',
    'sign up', 'subscribe', 'newsletter', 'password',
  ];

  const wordRe = (terms) =>
    new RegExp('(?<![\\p{L}\\p{N}])(?:' + terms.join('|') + ')(?![\\p{L}\\p{N}])', 'iu');

  const TOPIC_RE = wordRe(TOPIC_TERMS);
  const ACTION_RE = wordRe(ACTION_TERMS);
  const RISKY_RE = wordRe(RISKY_TERMS);
  const COOKIE_WORD_RE = wordRe(['cookies?']);

  const HINT_SELECTOR = [
    '[id*="cookie" i]', '[class*="cookie" i]',
    '[id*="consent" i]', '[class*="consent" i]',
    '[id*="gdpr" i]', '[class*="gdpr" i]',
    '[id*="privacy" i]', '[class*="privacy" i]',
    '[id*="banner" i]', '[class*="banner" i]',
    '[role="dialog"]', '[aria-modal="true"]',
  ].join(', ');

  const CONTROL_SELECTOR =
    'button, [role="button"], input[type="button"], input[type="submit"], a';

  // Inputs that suggest a real form (login, signup, search) rather than a
  // consent dialog. Checkboxes and radios are fine — consent dialogs use them.
  const SENSITIVE_INPUT_SELECTOR = [
    'input[type="password"]', 'input[type="email"]', 'input[type="text"]',
    'input[type="search"]', 'input[type="tel"]', 'input[type="number"]',
    'textarea',
  ].join(', ');

  const state = {
    hidingEnabled: true,
    // Elements we've already acted on (hidden or logged). Elements that merely
    // failed a gate are NOT recorded here: banners are often injected hidden
    // and revealed later, so they must be re-evaluated on subsequent scans.
    handled: new WeakSet(),
    loggedKeys: new Set(),
    pending: [],
    flushScheduled: false,
    scanScheduled: false,
  };

  // ---------------------------------------------------------------------
  // Detection

  function collectCandidates() {
    const candidates = new Set();
    for (const el of document.querySelectorAll(HINT_SELECTOR)) {
      candidates.add(el);
    }
    // Banners are very often fixed/sticky direct children of <body> with no
    // helpful id/class. Direct children are cheap to check.
    if (document.body) {
      for (const el of document.body.children) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') candidates.add(el);
      }
    }
    return [...candidates];
  }

  function isVisible(el, rect) {
    if (rect.width < 200 || rect.height < 40) return false;
    const style = getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      parseFloat(style.opacity) > 0.1
    );
  }

  // A banner should sit on top of the page (fixed/sticky/high z-index within
  // a few ancestors) or carry an explicit cookie/consent id or class.
  function looksOverlaid(el) {
    if (/cookie|consent|gdpr/i.test(el.id + ' ' + el.className)) return true;
    let node = el;
    for (let i = 0; i < 4 && node && node !== document.body; i++) {
      const style = getComputedStyle(node);
      if (style.position === 'fixed' || style.position === 'sticky') return true;
      const z = parseInt(style.zIndex, 10);
      if (!Number.isNaN(z) && z >= 50) return true;
      node = node.parentElement;
    }
    return false;
  }

  // Returns null if not a banner, otherwise { text, hideable, note }.
  function evaluate(el) {
    if (el === document.documentElement || el === document.body) return null;

    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) return null;

    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (text.length < 25 || text.length > 6000) return null;

    if (!TOPIC_RE.test(text)) return null;
    if (!el.querySelector(CONTROL_SELECTOR)) return null;
    // Check action words in the running text AND in each control's own label:
    // adjacent inline buttons concatenate in innerText ("AgreeDecline"),
    // which would defeat word-boundary matching.
    if (!ACTION_RE.test(text) && !buttonLabels(el).some((l) => ACTION_RE.test(l))) {
      return null;
    }
    if (!looksOverlaid(el)) return null;

    if (el.querySelector(SENSITIVE_INPUT_SELECTOR)) {
      return { text, hideable: false, note: 'has form inputs — logged only' };
    }
    if (RISKY_RE.test(text) && !COOKIE_WORD_RE.test(text)) {
      return { text, hideable: false, note: 'ambiguous wording — logged only' };
    }
    return { text, hideable: true, note: '' };
  }

  // If the banner sits inside a thin wrapper (dialog + backdrop pattern),
  // hide the wrapper so no dead overlay is left behind. Only climbs through
  // parents that contain little besides the banner itself.
  function expandTarget(el, textLength) {
    let target = el;
    let parent = target.parentElement;
    while (
      parent &&
      parent !== document.body &&
      parent !== document.documentElement &&
      parent.children.length <= 2 &&
      ((parent.innerText || '').trim().length <= textLength * 1.2)
    ) {
      target = parent;
      parent = target.parentElement;
    }
    return target;
  }

  function unlockScrollIfNeeded() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const style = getComputedStyle(el);
      if (style.overflow === 'hidden' || style.overflowY === 'hidden') {
        el.style.setProperty('overflow', 'auto', 'important');
      }
    }
  }

  function hideBanner(el, textLength) {
    const rect = el.getBoundingClientRect();
    const coverage =
      (rect.width * rect.height) / (window.innerWidth * window.innerHeight || 1);
    const target = expandTarget(el, textLength);
    target.style.setProperty('display', 'none', 'important');
    target.setAttribute('data-banner-scout', 'hidden');
    // Full-screen cookie walls usually lock scrolling; release it.
    if (coverage > 0.4) unlockScrollIfNeeded();
  }

  // ---------------------------------------------------------------------
  // Logging

  function buttonLabels(el) {
    return [...el.querySelectorAll(CONTROL_SELECTOR)]
      .map((b) => (b.innerText || b.value || '').replace(/\s+/g, ' ').trim())
      .filter((label) => label && label.length <= 60)
      .slice(0, 8);
  }

  function logSighting(el, text, hidden, note) {
    const key = location.hostname + '|' + text.slice(0, 80);
    if (state.loggedKeys.has(key)) return;
    state.loggedKeys.add(key);

    state.pending.push({
      ts: Date.now(),
      host: location.hostname,
      page: location.origin + location.pathname,
      snippet: text.slice(0, 240),
      buttons: buttonLabels(el),
      hidden,
      note,
    });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    setTimeout(flush, 300);
  }

  async function flush() {
    state.flushScheduled = false;
    const entries = state.pending.splice(0);
    if (!entries.length) return;

    const stored = await chrome.storage.local.get({
      bannerLog: [],
      counters: { seen: 0, hidden: 0 },
    });
    const log = stored.bannerLog.concat(entries).slice(-MAX_LOG_ENTRIES);
    const counters = {
      seen: stored.counters.seen + entries.length,
      hidden: stored.counters.hidden + entries.filter((e) => e.hidden).length,
    };
    await chrome.storage.local.set({ bannerLog: log, counters });
  }

  // ---------------------------------------------------------------------
  // Scanning

  function scan() {
    if (!document.body) return;
    const candidates = collectCandidates()
      .filter((el) => !state.handled.has(el))
      .slice(0, MAX_CANDIDATES_PER_SCAN);

    const found = [];
    for (const el of candidates) {
      const verdict = evaluate(el);
      if (verdict) found.push({ el, verdict });
    }

    // If a qualifying element contains another, act on the outermost only.
    const outermost = found.filter(
      ({ el }) => !found.some((other) => other.el !== el && other.el.contains(el))
    );

    for (const { el, verdict } of outermost) {
      state.handled.add(el);
      const shouldHide = state.hidingEnabled && verdict.hideable;
      if (shouldHide) hideBanner(el, verdict.text.length);
      logSighting(
        el,
        verdict.text,
        shouldHide,
        verdict.note || (state.hidingEnabled ? '' : 'hiding disabled — logged only')
      );
    }
  }

  function scheduleScan() {
    if (state.scanScheduled) return;
    state.scanScheduled = true;
    setTimeout(() => {
      state.scanScheduled = false;
      scan();
    }, 500);
  }

  // ---------------------------------------------------------------------
  // Boot

  async function main() {
    const settings = await chrome.storage.local.get({
      hidingEnabled: true,
      disabledSites: {},
    });
    if (settings.disabledSites[location.hostname]) return;
    state.hidingEnabled = settings.hidingEnabled;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.hidingEnabled) {
        state.hidingEnabled = changes.hidingEnabled.newValue;
      }
    });

    scan();
    // Banners frequently arrive late (tag managers, consent scripts).
    for (const delay of [1000, 3000, 8000]) setTimeout(scan, delay);

    // childList catches injected banners; attribute changes catch banners
    // that are present in the DOM but revealed later via class/style.
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
  }

  main();
})();
