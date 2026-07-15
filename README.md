# Cookie Monster

An experiment in neutralizing — and honestly measuring — cookie-banner nuisance.

## The model: hide, log, never consent

Most cookie-banner tools try to find and click the "reject" button. That
requires correctly classifying arbitrary UI on arbitrary sites, and a wrong
click on the wrong dialog is a real cost.

**Banner Scout** (in [`extension/`](extension/)) takes a different approach:

1. **Hide** the banner instead of interacting with it. No button is ever
   clicked, so no consent is ever given. Under GDPR-style regimes, no consent
   means compliant sites must not fire optional tracking.
2. **Log** every banner it sees — site, timestamp, text snippet, button
   labels — locally, in `chrome.storage.local`. Nothing leaves your machine.
3. **Never consent.** There is no code path that clicks anything.

The log is the point: it turns "is the long tail of weird cookie banners a
real nuisance?" from a vibe into data. After a few weeks of browsing, the
popup (and the JSON export) will show how many banners actually appeared,
on which sites, and which ones the heuristics weren't confident about.

### Global Privacy Control

As of v0.2.0 the extension also signals **Global Privacy Control** on every
request — the affirmative "do not sell or share my data" opt-out that carries
legal force under CCPA/CPRA and similar regimes. This is the honest complement
to hiding: we don't just stay silent, we say no in the standard way. Two
surfaces are set:

- `Sec-GPC: 1` HTTP request header (via a `declarativeNetRequest` rule) — the
  half servers act on.
- `navigator.globalPrivacyControl === true` (via a `document_start` MAIN-world
  script) — the half client-side scripts read.

**Permission cost:** the header rule requires `<all_urls>` host permission,
which reintroduces the broad permission v0.1.0 deliberately shed. That's a
deliberate trade — GPC without the header is only half the signal. GPC is
currently global and always-on when the extension is enabled; a toggle and
per-site control are on the roadmap.

## Safety posture

Detection is deliberately conservative, because hiding the wrong element is
worse than missing a banner:

- A candidate must mention a cookie/consent topic word **and** a consent
  action word (word-boundary matching, not substrings), contain a
  button/link, and be overlaid on the page (fixed/sticky/high z-index) or
  explicitly cookie-labeled.
- Candidates containing login-like inputs (password/email/text fields) or
  terms-of-service wording without the word "cookie" are **logged but left
  visible**.
- A global toggle switches to log-only mode; a per-site toggle disables the
  extension entirely on sites where it misbehaves.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` directory

## Reading the results

The toolbar popup shows banners seen today, total seen, total hidden, and
distinct sites, plus the recent log. **Export JSON** downloads the full log
for analysis. Entries with a badge ("logged only") are the interesting ones —
they're the ambiguous tail this experiment exists to measure.

## Roadmap (each step earned by the data)

- [x] **Global Privacy Control** *(v0.2.0)*: sends the `Sec-GPC` header and
      sets `navigator.globalPrivacyControl` so non-consent is signaled
      affirmatively where it has legal force.
- [ ] **GPC toggle / per-site control**: currently global and always-on;
      needs a background worker to toggle the ruleset at runtime.
- [ ] **Iframe CMPs**: banners rendered inside cross-origin iframes
      (e.g. Sourcepoint) are currently not detected (top frame only).
- [ ] **Cookie-wall detection**: flag sites that block content until consent,
      where hiding isn't enough.
- [ ] **Maybe, if the log justifies it**: on-device classification of the
      ambiguous tail via Chrome's built-in Prompt API (Gemini Nano) — the
      original "AI" premise, but earned by measurement and still fully local.

## History

This repo replaces an earlier copy-paste-from-chat prototype
(`smart-cookie-handler/`, untracked) that tried to auto-click reject buttons
using keyword matching labeled as AI. The post-mortem conclusions: clicking
is high-risk, substring matching misfires, and the speculative layer should
come last, not first. Hence the current model.
