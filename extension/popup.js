// Banner Scout — popup

const $ = (id) => document.getElementById(id);

let currentHost = null;

async function getCurrentHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https?:/.test(tab.url)) return new URL(tab.url).hostname;
  } catch (e) {
    // No activeTab access (e.g. chrome:// pages) — site toggle stays generic.
  }
  return null;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function renderLog(log) {
  const container = $('log');
  if (!log.length) {
    container.innerHTML = '<div class="empty">Nothing logged yet.</div>';
    return;
  }
  container.textContent = '';
  for (const entry of [...log].reverse().slice(0, 25)) {
    const div = document.createElement('div');
    div.className = 'entry';

    const top = document.createElement('div');
    top.className = 'top';
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = entry.host;
    if (!entry.hidden) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = entry.note || 'not hidden';
      badge.title = entry.note || '';
      host.appendChild(badge);
    }
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = timeAgo(entry.ts);
    top.append(host, when);

    const snippet = document.createElement('div');
    snippet.className = 'snippet';
    snippet.textContent = entry.snippet;

    div.append(top, snippet);
    container.appendChild(div);
  }
}

function renderStats(log, counters) {
  const dayStart = new Date().setHours(0, 0, 0, 0);
  $('statToday').textContent = log.filter((e) => e.ts >= dayStart).length;
  $('statSeen').textContent = counters.seen;
  $('statHidden').textContent = counters.hidden;
  $('statSites').textContent = new Set(log.map((e) => e.host)).size;
}

async function render() {
  const stored = await chrome.storage.local.get({
    hidingEnabled: true,
    disabledSites: {},
    bannerLog: [],
    counters: { seen: 0, hidden: 0 },
  });

  $('hidingEnabled').checked = stored.hidingEnabled;

  if (currentHost) {
    $('siteHost').textContent = currentHost;
    $('siteEnabled').checked = !stored.disabledSites[currentHost];
  } else {
    $('siteEnabled').disabled = true;
  }

  renderStats(stored.bannerLog, stored.counters);
  renderLog(stored.bannerLog);
}

function setupListeners() {
  $('hidingEnabled').addEventListener('change', (e) => {
    chrome.storage.local.set({ hidingEnabled: e.target.checked });
  });

  $('siteEnabled').addEventListener('change', async (e) => {
    if (!currentHost) return;
    const { disabledSites } = await chrome.storage.local.get({ disabledSites: {} });
    if (e.target.checked) {
      delete disabledSites[currentHost];
    } else {
      disabledSites[currentHost] = true;
    }
    await chrome.storage.local.set({ disabledSites });
  });

  $('exportBtn').addEventListener('click', async () => {
    const stored = await chrome.storage.local.get({
      bannerLog: [],
      counters: { seen: 0, hidden: 0 },
    });
    const blob = new Blob(
      [JSON.stringify({ exportedAt: new Date().toISOString(), ...stored }, null, 2)],
      { type: 'application/json' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `banner-scout-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('clearBtn').addEventListener('click', async () => {
    if (!confirm('Clear the banner log and counters?')) return;
    await chrome.storage.local.set({
      bannerLog: [],
      counters: { seen: 0, hidden: 0 },
    });
    render();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  currentHost = await getCurrentHost();
  setupListeners();
  render();
});
