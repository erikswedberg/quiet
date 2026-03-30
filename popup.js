// FeedFence Popup Controller

// DOM Elements
const toggleSwitch = document.getElementById('toggleSwitch');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statShown = document.getElementById('statShown');
const statHidden = document.getElementById('statHidden');
const statFriends = document.getElementById('statFriends');
const modeFriends = document.getElementById('modeFriends');
const modeGroups = document.getElementById('modeGroups');
const modeOff = document.getElementById('modeOff');
const importFriendsBtn = document.getElementById('importFriendsBtn');
const viewTimelineBtn = document.getElementById('viewTimelineBtn');
const manageFriendsBtn = document.getElementById('manageFriendsBtn');
const friendsListContainer = document.getElementById('friendsListContainer');
const searchInput = document.getElementById('searchInput');
const friendsListEl = document.getElementById('friendsList');
const friendsCountEl = document.getElementById('friendsCount');

// State
let currentFriends = []; // Array of { name, url }
let isEnabled = true;
let currentMode = 'friends';

// ─── Facebook tab communication ──────────────────────────────────────

async function getFacebookTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.url?.includes('facebook.com')) return tabs[0];
  const fbTabs = await chrome.tabs.query({ url: '*://*.facebook.com/*' });
  return fbTabs[0] || null;
}

async function sendToContent(type, data = {}) {
  const tab = await getFacebookTab();
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type, ...data });
  } catch (err) {
    console.warn('[FeedFence popup] sendMessage failed:', err.message);
    return null;
  }
}

// ─── UI update helpers ───────────────────────────────────────────────

function updateStats(data) {
  if (!data) return;
  // Content script responds with { stats: {...}, friendsCount, mode, enabled }
  const s = data.stats || data;
  statShown.textContent = s.shown ?? 0;
  statHidden.textContent = s.hidden ?? 0;
  statFriends.textContent = data.friendsCount ?? s.friendsCount ?? currentFriends.length;
}

function updateStatus(on) {
  isEnabled = on;
  toggleSwitch.classList.toggle('active', on);
  statusDot.classList.toggle('active', on);
  statusText.textContent = on ? 'Active' : 'Paused';
}

function updateMode(m) {
  currentMode = m;
  [modeFriends, modeGroups, modeOff].forEach(btn => btn.classList.remove('active'));
  const map = { friends: modeFriends, groups: modeGroups, off: modeOff };
  if (map[m]) map[m].classList.add('active');
}

// ─── Friends list rendering ──────────────────────────────────────────

function renderFriendsList(filter = '') {
  const q = filter.toLowerCase();
  const filtered = q
    ? currentFriends.filter(f => f.name.toLowerCase().includes(q) || f.url.includes(q))
    : currentFriends;

  friendsCountEl.textContent = `${currentFriends.length} friend${currentFriends.length !== 1 ? 's' : ''}`;
  friendsListEl.innerHTML = '';

  if (filtered.length === 0) {
    friendsListEl.innerHTML = '<div style="text-align:center;padding:20px;color:#888">' +
      (currentFriends.length === 0
        ? 'No friends yet. Visit facebook.com/friends to import.'
        : 'No matches') +
      '</div>';
    return;
  }

  for (const friend of filtered) {
    const item = document.createElement('div');
    item.className = 'friend-item';

    const nameEl = document.createElement('span');
    nameEl.className = 'friend-name';
    // Capitalize stored lowercase name
    nameEl.textContent = friend.name.replace(/\b\w/g, c => c.toUpperCase());

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', async () => {
      await sendToContent('feedfence:removeFriend', { url: friend.url });
      await loadFriends();
    });

    item.appendChild(nameEl);
    item.appendChild(removeBtn);
    friendsListEl.appendChild(item);
  }
}

async function loadFriends() {
  const resp = await sendToContent('feedfence:getFriends');
  if (resp?.friends) {
    currentFriends = resp.friends; // [{ name, url }]
    renderFriendsList(searchInput.value);
    statFriends.textContent = currentFriends.length;
  }
}

// ─── Event handlers ──────────────────────────────────────────────────

toggleSwitch.addEventListener('click', async () => {
  const newState = !isEnabled;
  updateStatus(newState);
  await sendToContent('feedfence:setEnabled', { enabled: newState });
});

[modeFriends, modeGroups, modeOff].forEach(btn => {
  btn.addEventListener('click', async () => {
    const m = btn.dataset.mode;
    updateMode(m);
    await sendToContent('feedfence:setMode', { mode: m });
  });
});

importFriendsBtn.addEventListener('click', async () => {
  const tab = await getFacebookTab();

  if (!tab?.url?.includes('facebook.com/friends')) {
    // Open friends page first
    await chrome.tabs.create({ url: 'https://www.facebook.com/friends/list' });
    importFriendsBtn.textContent = '📥 Now scroll down, then click Import again';
    return;
  }

  importFriendsBtn.textContent = '⏳ Scanning...';
  await sendToContent('feedfence:importFriends');
  importFriendsBtn.textContent = '📥 Import Friends';
  await loadFriends();
});

viewTimelineBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('timeline.html') });
});

manageFriendsBtn.addEventListener('click', () => {
  const visible = friendsListContainer.classList.toggle('visible');
  if (visible) loadFriends();
});

searchInput.addEventListener('input', (e) => {
  renderFriendsList(e.target.value);
});

// ─── Real-time stats updates ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'feedfence:stats') {
    updateStats(msg);
  }
});

// ─── Init ────────────────────────────────────────────────────────────

async function init() {
  // Try to get stats from the active Facebook tab
  const resp = await sendToContent('feedfence:getStats');
  if (resp) {
    updateStats(resp);
    if (resp.enabled !== undefined) updateStatus(resp.enabled);
    if (resp.mode) updateMode(resp.mode);
  }

  await loadFriends();

  // If no Facebook tab is open, show a hint
  const tab = await getFacebookTab();
  if (!tab) {
    statusText.textContent = 'No Facebook tab';
    statusDot.classList.remove('active');
  }
}

init();
