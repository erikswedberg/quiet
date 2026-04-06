// Quiet Popup Controller

const STORAGE_KEY = 'quiet';

// DOM Elements
const toggleSwitch = document.getElementById('toggleSwitch');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const countFriends = document.getElementById('countFriends');
const countGroups = document.getElementById('countGroups');
const countPages = document.getElementById('countPages');
const countBlocked = document.getElementById('countBlocked');
const modeFriends = document.getElementById('modeFriends');
const modeGroups = document.getElementById('modeGroups');
const modePages = document.getElementById('modePages');
const modeBlocked = document.getElementById('modeBlocked');
const modeOff = document.getElementById('modeOff');
const importFriendsBtn = document.getElementById('importFriendsBtn');
const importGroupsBtn = document.getElementById('importGroupsBtn');
const importPagesBtn = document.getElementById('importPagesBtn');
const viewTimelineBtn = document.getElementById('viewTimelineBtn');
const manageFriendsBtn = document.getElementById('manageFriendsBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const friendsListContainer = document.getElementById('friendsListContainer');
const searchInput = document.getElementById('searchInput');
const friendsListEl = document.getElementById('friendsList');
const friendsCountEl = document.getElementById('friendsCount');

// State
let currentFriends = []; // Array of { name, url }
let isEnabled = true;
let currentMode = 'friends';

// ============================================================================
// STORAGE (read directly, no content script needed)
// ============================================================================

async function loadStateFromStorage() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const data = result[STORAGE_KEY];
    if (!data) return null;
    return data;
  } catch (err) {
    console.warn('[Quiet popup] Failed to read storage:', err.message);
    return null;
  }
}

// ============================================================================
// FACEBOOK TAB COMMUNICATION
// ============================================================================

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
    console.warn('[Quiet popup] sendMessage failed:', type, err.message);
    return null;
  }
}

// ============================================================================
// UI UPDATE HELPERS
// ============================================================================

function updateImportBtnLabel(btn, base, count) {
  btn.textContent = count > 0 ? `${base} (${count})` : base;
}

function updateStatus(on) {
  isEnabled = on;
  toggleSwitch.classList.toggle('active', on);
  statusDot.classList.toggle('active', on);
  statusText.textContent = on ? 'Active' : 'Paused';
}

function updateMode(m) {
  currentMode = m;
  [modeFriends, modeGroups, modePages, modeBlocked, modeOff].forEach(btn => btn.classList.remove('active'));
  const map = { friends: modeFriends, groups: modeGroups, pages: modePages, blocked: modeBlocked, off: modeOff };
  if (map[m]) map[m].classList.add('active');
}

// ============================================================================
// FRIENDS LIST RENDERING
// ============================================================================

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
    nameEl.textContent = friend.name.replace(/\b\w/g, c => c.toUpperCase());

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = 'x';
    removeBtn.addEventListener('click', async () => {
      await sendToContent('quiet:removeFriend', { url: friend.url });
      await loadFriendsFromStorage();
    });

    item.appendChild(nameEl);
    item.appendChild(removeBtn);
    friendsListEl.appendChild(item);
  }
}

async function loadFriendsFromStorage() {
  const data = await loadStateFromStorage();
  if (!data) return;

  const friendsList = Array.isArray(data.friendsList) ? data.friendsList : [];
  const friendNames = (data.friendNames && typeof data.friendNames === 'object') ? data.friendNames : {};

  // Build reverse map: url -> name
  const urlToName = {};
  for (const [name, url] of Object.entries(friendNames)) {
    urlToName[url] = name;
  }

  currentFriends = friendsList.map(url => ({
    url,
    name: urlToName[url] || ''
  }));
  currentFriends.sort((a, b) => a.name.localeCompare(b.name));

  renderFriendsList(searchInput.value);
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

toggleSwitch.addEventListener('click', async () => {
  const newState = !isEnabled;
  updateStatus(newState);
  await sendToContent('quiet:setEnabled', { enabled: newState });
});

[modeFriends, modeGroups, modePages, modeBlocked, modeOff].forEach(btn => {
  btn.addEventListener('click', async () => {
    const m = btn.dataset.mode;
    updateMode(m);
    await sendToContent('quiet:setMode', { mode: m });
  });
});

importFriendsBtn.addEventListener('click', async () => {
  const tab = await getFacebookTab();

  if (!tab?.url?.includes('facebook.com/friends/list')) {
    await chrome.tabs.create({ url: 'https://www.facebook.com/friends/list' });
    importFriendsBtn.textContent = 'Now scroll down, then click Import again';
    return;
  }

  importFriendsBtn.textContent = 'Scanning...';
  await sendToContent('quiet:importFriends');
  await loadFriendsFromStorage();
  const d1 = await loadStateFromStorage();
  updateImportBtnLabel(importFriendsBtn, 'Import Friends', d1?.friendsList?.length ?? 0);
});

importGroupsBtn.addEventListener('click', async () => {
  const tab = await getFacebookTab();

  if (!tab?.url?.includes('facebook.com/groups/joins')) {
    await chrome.tabs.create({ url: 'https://www.facebook.com/groups/joins/?nav_source=tab' });
    importGroupsBtn.textContent = 'Now scroll down, then click Import again';
    return;
  }

  importGroupsBtn.textContent = 'Scanning...';
  await sendToContent('quiet:importGroups');
  const d2 = await loadStateFromStorage();
  updateImportBtnLabel(importGroupsBtn, 'Import Groups', d2?.groupsList?.length ?? 0);
});

viewTimelineBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('timeline.html') });
});

manageFriendsBtn.addEventListener('click', () => {
  const visible = friendsListContainer.classList.toggle('visible');
  if (visible) loadFriendsFromStorage();
});

clearAllBtn.addEventListener('click', async () => {
  if (!confirm('Remove all friends? You can re-import from facebook.com/friends/list.')) return;
  await sendToContent('quiet:clearList', { list: 'friends' });
  await loadFriendsFromStorage();
  updateImportBtnLabel(importFriendsBtn, 'Import Friends', 0);
});

importPagesBtn.addEventListener('click', async () => {
  const tab = await getFacebookTab();

  if (!tab?.url?.includes('facebook.com/pages') || !tab?.url?.includes('category=liked')) {
    await chrome.tabs.create({ url: 'https://www.facebook.com/pages/?category=liked&ref=bookmarks' });
    importPagesBtn.textContent = 'Now scroll down, then click Import again';
    return;
  }

  importPagesBtn.textContent = 'Scanning...';
  await sendToContent('quiet:importPages');
  const d3 = await loadStateFromStorage();
  updateImportBtnLabel(importPagesBtn, 'Import Pages', d3?.pagesList?.length ?? 0);
});

searchInput.addEventListener('input', (e) => {
  renderFriendsList(e.target.value);
});

// ============================================================================
// REAL-TIME STATS UPDATES (from content script broadcasts)
// ============================================================================

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'quiet:stats') {
    updatePostCounts(msg.stats);
  }
});

function updatePostCounts(stats) {
  if (!stats) return;
  const f = stats.friends ?? 0;
  const g = stats.groups ?? 0;
  const p = stats.pages ?? 0;
  const b = stats.blocked ?? 0;
  countFriends.textContent = f > 0 ? f + ' posts' : '';
  countGroups.textContent = g > 0 ? g + ' posts' : '';
  countPages.textContent = p > 0 ? p + ' posts' : '';
  countBlocked.textContent = b > 0 ? b + ' blocked' : '';
}

// ============================================================================
// INIT
// ============================================================================

async function init() {
  // 1. Read counts, mode, enabled from storage — instant, no content script needed
  const data = await loadStateFromStorage();
  if (data) {
    // List counts shown in tab buttons when no post counts yet
    const friendsCount = Array.isArray(data.friendsList) ? data.friendsList.length : 0;
    const groupsCount = Array.isArray(data.groupsList) ? data.groupsList.length : 0;
    const pagesCount = Array.isArray(data.pagesList) ? data.pagesList.length : 0;
    updateImportBtnLabel(importFriendsBtn, 'Import Friends', friendsCount);
    updateImportBtnLabel(importGroupsBtn, 'Import Groups', groupsCount);
    updateImportBtnLabel(importPagesBtn, 'Import Pages', pagesCount);

    if (typeof data.enabled === 'boolean') updateStatus(data.enabled);
    if (typeof data.mode === 'string') updateMode(data.mode);
  }

  // 2. Try to get live post counts from the content script (best-effort)
  const resp = await sendToContent('quiet:getStats');
  if (resp?.stats) {
    updatePostCounts(resp.stats);
  }

  // 3. If no Facebook tab, show hint
  const tab = await getFacebookTab();
  if (!tab) {
    statusText.textContent = 'No Facebook tab';
    statusDot.classList.remove('active');
  }
}

init();
