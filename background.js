// Quiet - Background Service Worker (MV3)
// Handles installation, storage initialization, badge updates, and alarms

// Initialize storage on install
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get('quiet');
  if (!data.quiet) {
    await chrome.storage.local.set({
      quiet: {
        friendsList: [],
        friendNames: {},
        enabled: true,
        mode: 'friends',
        savedPosts: []
      }
    });
  }
  
  // Set up alarm for future friend visiting feature
  chrome.alarms.create('quiet-check', { periodInMinutes: 60 });
});

// Listen for stats updates from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'quiet:stats') {
    // Update badge with hidden post count
    const hidden = message.stats?.hidden || 0;
    const text = hidden > 0 ? String(hidden) : '';
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#e94560' });
  }
  return true;
});

// Alarm handler (placeholder for friend visiting)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'quiet-check') {
    console.log('[Quiet] Periodic check alarm fired');
    // Future: round-robin friend profile visiting
  }
});
