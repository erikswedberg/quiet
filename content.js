/**
 * FeedFence - Facebook News Feed Filter
 * Content Script
 * 
 * Filters Facebook's news feed to show only posts from friends you care about.
 * Provides peek bars for hidden posts with quick actions.
 */

(function() {
  'use strict';

  // ============================================================================
  // STATE
  // ============================================================================

  let friendsList = new Set();        // Profile URL keys: "user:johndoe" or "profile:12345"
  let friendNames = new Map();        // Lowercase display name → profile URL key
  let enabled = true;                 // Whether filtering is active
  let mode = 'friends';               // 'friends' | 'groups' | 'off'
  let stats = {                       // Statistics
    total: 0,
    shown: 0,
    hidden: 0
  };
  let processedPosts = new WeakSet(); // Track which posts we've already processed
  let savedPosts = [];                // Array of saved post objects
  const STORAGE_KEY = 'feedfence';    // Key for chrome.storage.local

  let observer = null;                // MutationObserver instance
  let saveStateTimeout = null;        // Debounce timer for saving state

  // ============================================================================
  // STORAGE
  // ============================================================================

  /**
   * Load state from chrome.storage.local
   */
  async function loadState() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const data = result[STORAGE_KEY];
      
      if (data) {
        // Load friends list
        if (Array.isArray(data.friendsList)) {
          friendsList = new Set(data.friendsList);
        }
        
        // Load friend names map
        if (data.friendNames && typeof data.friendNames === 'object') {
          friendNames = new Map(Object.entries(data.friendNames));
        }
        
        // Load enabled state
        if (typeof data.enabled === 'boolean') {
          enabled = data.enabled;
        }
        
        // Load mode
        if (typeof data.mode === 'string') {
          mode = data.mode;
        }
        
        // Load saved posts
        if (Array.isArray(data.savedPosts)) {
          savedPosts = data.savedPosts;
        }
      }
    } catch (error) {
      console.error('[FeedFence] Failed to load state:', error);
    }
  }

  /**
   * Save state to chrome.storage.local
   */
  async function saveState() {
    try {
      // Cap saved posts at 5000
      if (savedPosts.length > 5000) {
        savedPosts = savedPosts.slice(0, 5000);
      }
      
      const data = {
        friendsList: Array.from(friendsList),
        friendNames: Object.fromEntries(friendNames),
        enabled: enabled,
        mode: mode,
        savedPosts: savedPosts
      };
      
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
    } catch (error) {
      console.error('[FeedFence] Failed to save state:', error);
    }
  }

  /**
   * Debounced save state (waits 2 seconds before saving)
   */
  function debounceSaveState() {
    if (saveStateTimeout) {
      clearTimeout(saveStateTimeout);
    }
    saveStateTimeout = setTimeout(() => {
      saveState();
    }, 2000);
  }

  // ============================================================================
  // PROFILE URL NORMALIZATION
  // ============================================================================

  /**
   * Normalize a Facebook profile URL to a canonical key format
   * @param {string} href - The URL to normalize
   * @returns {string|null} - Normalized key like "user:johndoe" or "profile:12345", or null
   */
  function normalizeProfileUrl(href) {
    if (!href) return null;
    
    try {
      const url = new URL(href, 'https://www.facebook.com');
      
      // Handle /profile.php?id=XXX format
      if (url.pathname === '/profile.php') {
        const id = url.searchParams.get('id');
        if (id) {
          return `profile:${id}`;
        }
      }
      
      // Skip certain paths that aren't profiles
      const skipPaths = [
        '/stories', '/watch', '/marketplace', '/groups', '/events',
        '/pages', '/gaming', '/reel', '/share', '/photo', '/permalink',
        '/posts', '/videos', '/hashtag', '/settings', '/notifications',
        '/messages', '/bookmarks', '/memories'
      ];
      
      for (const skipPath of skipPaths) {
        if (url.pathname.startsWith(skipPath)) {
          return null;
        }
      }
      
      // Single-segment paths like /johndoe
      const pathParts = url.pathname.split('/').filter(p => p.length > 0);
      if (pathParts.length === 1) {
        return `user:${pathParts[0]}`;
      }
      
      // Anything else is not a simple profile URL
      return null;
    } catch (error) {
      return null;
    }
  }

  // ============================================================================
  // AUTHOR EXTRACTION
  // ============================================================================

  /**
   * Extract author information from a post element
   * @param {Element} postEl - The post element
   * @returns {Object|null} - { name: string, profileUrl: string } or null
   */
  function extractAuthorInfo(postEl) {
    const candidates = [];
    
    // Strategy 1: Find links containing profile photos (svg or img)
    const photoLinks = postEl.querySelectorAll('a[role="link"]');
    for (const link of photoLinks) {
      const href = link.getAttribute('href');
      if (!href) continue;
      
      // Skip unwanted link types
      if (href.includes('/permalink') || href.includes('/photos/') || 
          href.includes('#') || href.includes('comment') || 
          href.includes('reaction') || href.includes('/groups/')) {
        continue;
      }
      
      // Check if this link contains an svg or img (profile picture indicator)
      const svg = link.querySelector('svg[aria-label]');
      const img = link.querySelector('img');
      
      if (svg || img) {
        let name = null;
        
        // Try to get name from svg aria-label
        if (svg) {
          name = svg.getAttribute('aria-label');
        }
        
        // Try link's own aria-label
        if (!name) {
          name = link.getAttribute('aria-label');
        }
        
        // Try first span text
        if (!name) {
          const span = link.querySelector('span');
          if (span) {
            name = span.textContent.trim();
          }
        }
        
        // Validate name
        if (name && name.length > 0 && name.length <= 80) {
          const profileUrl = normalizeProfileUrl(href);
          if (profileUrl) {
            const rect = link.getBoundingClientRect();
            candidates.push({ name, profileUrl, top: rect.top });
          }
        }
      }
    }
    
    // Strategy 2: Header links (h2, h3, h4)
    const headerLinks = postEl.querySelectorAll('h2 a[role="link"], h3 a[role="link"], h4 a[role="link"]');
    for (const link of headerLinks) {
      const href = link.getAttribute('href');
      if (!href) continue;
      
      if (href.includes('/permalink') || href.includes('/photos/') || 
          href.includes('#') || href.includes('comment') || 
          href.includes('reaction') || href.includes('/groups/')) {
        continue;
      }
      
      const name = link.textContent.trim();
      if (name && name.length > 0 && name.length <= 80) {
        const profileUrl = normalizeProfileUrl(href);
        if (profileUrl) {
          const rect = link.getBoundingClientRect();
          candidates.push({ name, profileUrl, top: rect.top });
        }
      }
    }
    
    // Strategy 3: Strong > a links
    const strongLinks = postEl.querySelectorAll('strong a[role="link"]');
    for (const link of strongLinks) {
      const href = link.getAttribute('href');
      if (!href) continue;
      
      if (href.includes('/permalink') || href.includes('/photos/') || 
          href.includes('#') || href.includes('comment') || 
          href.includes('reaction') || href.includes('/groups/')) {
        continue;
      }
      
      const name = link.textContent.trim();
      if (name && name.length > 0 && name.length <= 80) {
        const profileUrl = normalizeProfileUrl(href);
        if (profileUrl) {
          const rect = link.getBoundingClientRect();
          candidates.push({ name, profileUrl, top: rect.top });
        }
      }
    }
    
    // Prefer candidates with smallest top value (closest to top of post)
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.top - b.top);
      return { name: candidates[0].name, profileUrl: candidates[0].profileUrl };
    }
    
    return null;
  }

  // ============================================================================
  // POST CLASSIFICATION
  // ============================================================================

  /**
   * Check if a post is sponsored
   * @param {Element} postEl - The post element
   * @returns {boolean}
   */
  function isSponsored(postEl) {
    // Check for "Sponsored" text
    const links = postEl.querySelectorAll('a[href*="ads/about"]');
    for (const link of links) {
      if (link.textContent.trim() === 'Sponsored') {
        return true;
      }
    }
    
    const spans = postEl.querySelectorAll('span');
    for (const span of spans) {
      if (span.textContent.trim() === 'Sponsored') {
        // Verify it's a small label
        const rect = span.getBoundingClientRect();
        if (rect.width < 300 && rect.height < 40) {
          return true;
        }
      }
    }
    
    // Check for ads link near timestamp
    const adsLinks = postEl.querySelectorAll('a[href*="/ads/"]');
    if (adsLinks.length > 0) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if a post is suggested content
   * @param {Element} postEl - The post element
   * @returns {boolean}
   */
  function isSuggested(postEl) {
    const suggestedPhrases = [
      'Suggested for you',
      'People you may know',
      'Reels and short videos',
      'Join this group',
      'Follow',
      'Popular near you',
      'Related discussions'
    ];
    
    const spans = postEl.querySelectorAll('span');
    let count = 0;
    for (const span of spans) {
      const text = span.textContent.trim();
      for (const phrase of suggestedPhrases) {
        if (text === phrase) {
          return true;
        }
      }
      
      count++;
      if (count > 20) break; // Only check first 20 spans
    }
    
    return false;
  }

  /**
   * Check if a post is from a group
   * @param {Element} postEl - The post element
   * @returns {boolean}
   */
  function isGroupPost(postEl) {
    const groupLinks = postEl.querySelectorAll('a[href*="/groups/"]');
    return groupLinks.length > 0;
  }

  // ============================================================================
  // CORE FILTER LOGIC
  // ============================================================================

  /**
   * Determine if a post should be shown based on current filter settings
   * @param {Element} postEl - The post element
   * @returns {boolean} - True if post should be shown
   */
  function shouldShowPost(postEl) {
    // If filtering is disabled, show everything
    if (!enabled) {
      return true;
    }
    
    // Hide sponsored posts
    if (isSponsored(postEl)) {
      return false;
    }
    
    // Hide suggested content
    if (isSuggested(postEl)) {
      return false;
    }
    
    // Extract author
    const author = extractAuthorInfo(postEl);
    
    // If we can't determine the author
    if (!author) {
      const textContent = postEl.textContent || '';
      // If post has very little text, it's probably a structural element
      if (textContent.length < 50) {
        return true;
      }
      // Unknown author with content = hide
      return false;
    }
    
    // Mode-based filtering
    if (mode === 'friends') {
      // Check if author is in friends list
      if (friendsList.has(author.profileUrl)) {
        return true;
      }
      
      // Check if author name matches any friend name
      const lowerName = author.name.toLowerCase();
      for (const [name, url] of friendNames.entries()) {
        if (name === lowerName) {
          return true;
        }
      }
      
      return false;
    } else if (mode === 'groups') {
      return isGroupPost(postEl);
    } else if (mode === 'off') {
      return true;
    }
    
    return true;
  }

  // ============================================================================
  // POST PROCESSING
  // ============================================================================

  /**
   * Process a single post element
   * @param {Element} postEl - The post element to process
   */
  function processPost(postEl) {
    // Skip if already processed
    if (processedPosts.has(postEl)) {
      return;
    }
    
    // Mark as processed
    processedPosts.add(postEl);
    stats.total++;
    
    // Determine if post should be shown
    const show = shouldShowPost(postEl);
    
    if (show) {
      postEl.classList.add('feedfence-shown');
      postEl.classList.remove('feedfence-hidden');
      stats.shown++;
      
      // Remove peek bar if it exists
      const existingPeek = postEl.querySelector('.feedfence-peek');
      if (existingPeek) {
        existingPeek.remove();
      }
    } else {
      postEl.classList.add('feedfence-hidden');
      postEl.classList.remove('feedfence-shown');
      stats.hidden++;
      
      // Inject peek bar
      injectPeekBar(postEl);
    }
    
    // Try to save post data
    const author = extractAuthorInfo(postEl);
    if (author) {
      savePost(postEl, author);
    }
    
    // Broadcast updated stats
    broadcastStats();
  }

  // ============================================================================
  // PEEK BARS
  // ============================================================================

  /**
   * Inject a peek bar for a hidden post
   * @param {Element} postEl - The hidden post element
   */
  function injectPeekBar(postEl) {
    // Don't inject if one already exists
    if (postEl.querySelector('.feedfence-peek')) {
      return;
    }
    
    const author = extractAuthorInfo(postEl);
    const authorName = author ? author.name : 'Unknown source';
    const authorUrl = author ? author.profileUrl : null;
    
    // Create peek bar
    const peekBar = document.createElement('div');
    peekBar.className = 'feedfence-peek';
    
    const icon = document.createElement('span');
    icon.className = 'feedfence-peek-icon';
    icon.textContent = '🛡️';
    
    const label = document.createElement('span');
    label.className = 'feedfence-peek-label';
    label.textContent = 'Hidden:';
    
    const authorSpan = document.createElement('span');
    authorSpan.className = 'feedfence-peek-author';
    authorSpan.textContent = authorName;
    
    const addButton = document.createElement('button');
    addButton.className = 'feedfence-peek-add';
    addButton.textContent = '＋ Add';
    
    const showButton = document.createElement('button');
    showButton.className = 'feedfence-peek-show';
    showButton.textContent = 'Show once';
    
    // Add button click handler
    addButton.addEventListener('click', (e) => {
      e.stopPropagation();
      if (authorUrl) {
        friendsList.add(authorUrl);
        friendNames.set(authorName.toLowerCase(), authorUrl);
        saveState();
        showToast(`Added ${authorName} to friends list`);
        reprocessAll();
      }
    });
    
    // Show button click handler
    showButton.addEventListener('click', (e) => {
      e.stopPropagation();
      postEl.classList.remove('feedfence-hidden');
      peekBar.remove();
    });
    
    // Assemble peek bar
    peekBar.appendChild(icon);
    peekBar.appendChild(label);
    peekBar.appendChild(authorSpan);
    if (authorUrl) {
      peekBar.appendChild(addButton);
    }
    peekBar.appendChild(showButton);
    
    // Insert at the beginning of the post
    postEl.insertBefore(peekBar, postEl.firstChild);
  }

  // ============================================================================
  // FRIENDS PAGE IMPORT
  // ============================================================================

  /**
   * Check if we're on the friends page and extract friends
   * @returns {number} - Number of friends found
   */
  function checkFriendsPage() {
    // Only run on friends page
    if (!window.location.pathname.includes('/friends')) {
      return 0;
    }
    
    let count = 0;
    const links = document.querySelectorAll('a[role="link"]');
    
    for (const link of links) {
      const svg = link.querySelector('svg[aria-label]');
      if (!svg) continue;
      
      const name = svg.getAttribute('aria-label');
      const href = link.getAttribute('href');
      
      if (name && href) {
        const profileUrl = normalizeProfileUrl(href);
        if (profileUrl && !friendsList.has(profileUrl)) {
          friendsList.add(profileUrl);
          friendNames.set(name.toLowerCase(), profileUrl);
          count++;
        }
      }
    }
    
    if (count > 0) {
      saveState();
    }
    
    return count;
  }

  /**
   * Auto-import friends from the friends page with progress updates
   */
  function autoImportFriendsFromPage() {
    if (!window.location.pathname.includes('/friends')) {
      showToast('Please navigate to your Friends page first');
      return;
    }
    
    showToast('Starting auto-import from Friends page...');
    
    let totalImported = 0;
    let intervalCount = 0;
    const maxIntervals = 30; // 30 intervals * 2s = 60 seconds
    
    const importInterval = setInterval(() => {
      const newCount = checkFriendsPage();
      totalImported += newCount;
      intervalCount++;
      
      if (newCount > 0) {
        showToast(`Imported ${totalImported} friends so far...`);
      }
      
      // Stop after 60 seconds
      if (intervalCount >= maxIntervals) {
        clearInterval(importInterval);
        showToast(`Auto-import complete! Imported ${totalImported} friends.`);
      }
    }, 2000);
  }

  // ============================================================================
  // PROFILE PAGE DETECTION
  // ============================================================================

  /**
   * Check if we're on a profile page and show add banner if needed
   */
  function checkProfilePage() {
    const pathParts = window.location.pathname.split('/').filter(p => p.length > 0);
    
    // Must be a single-segment path (e.g., /johndoe)
    if (pathParts.length !== 1) {
      return;
    }
    
    // Try to find the profile name from h1
    const h1 = document.querySelector('h1');
    if (!h1) return;
    
    const name = h1.textContent.trim();
    if (!name) return;
    
    // Normalize profile URL
    const profileUrl = normalizeProfileUrl(window.location.pathname);
    if (!profileUrl) return;
    
    // Skip if already in friends list
    if (friendsList.has(profileUrl)) {
      return;
    }
    
    // Skip if banner already exists
    if (document.querySelector('.feedfence-profile-banner')) {
      return;
    }
    
    // Create banner
    const banner = document.createElement('div');
    banner.className = 'feedfence-profile-banner';
    banner.innerHTML = `
      <div class="feedfence-profile-banner-content">
        <span class="feedfence-profile-banner-icon">🛡️</span>
        <span class="feedfence-profile-banner-text">Add <strong>${name}</strong> to FeedFence?</span>
        <button class="feedfence-profile-banner-add">Add Friend</button>
        <button class="feedfence-profile-banner-dismiss">Dismiss</button>
      </div>
    `;
    
    // Add button handler
    const addButton = banner.querySelector('.feedfence-profile-banner-add');
    addButton.addEventListener('click', () => {
      friendsList.add(profileUrl);
      friendNames.set(name.toLowerCase(), profileUrl);
      saveState();
      showToast(`Added ${name} to friends list`);
      banner.remove();
    });
    
    // Dismiss button handler
    const dismissButton = banner.querySelector('.feedfence-profile-banner-dismiss');
    dismissButton.addEventListener('click', () => {
      banner.remove();
    });
    
    // Insert banner at top of page
    document.body.insertBefore(banner, document.body.firstChild);
  }

  // ============================================================================
  // POST SAVING
  // ============================================================================

  /**
   * Save post data for later retrieval
   * @param {Element} postEl - The post element
   * @param {Object} author - The author object { name, profileUrl }
   */
  function savePost(postEl, author) {
    try {
      // Extract post text
      let text = '';
      const messageEl = postEl.querySelector('[data-ad-preview="message"]');
      if (messageEl) {
        text = messageEl.textContent.trim();
      } else {
        const autoSpans = postEl.querySelectorAll('[dir="auto"]');
        for (const span of autoSpans) {
          const spanText = span.textContent.trim();
          if (spanText.length > text.length) {
            text = spanText;
          }
        }
      }
      
      // Limit text to 1000 chars
      if (text.length > 1000) {
        text = text.substring(0, 1000) + '...';
      }
      
      // Create post object
      const post = {
        id: `${author.profileUrl}_${Date.now()}`,
        authorName: author.name,
        authorUrl: author.profileUrl,
        text: text,
        timestamp: Date.now()
      };
      
      // Dedupe by author + text
      const isDupe = savedPosts.some(p => 
        p.authorUrl === post.authorUrl && p.text === post.text
      );
      
      if (!isDupe) {
        savedPosts.unshift(post);
        debounceSaveState();
      }
    } catch (error) {
      // Silently fail - not critical
    }
  }

  // ============================================================================
  // MUTATION OBSERVER
  // ============================================================================

  /**
   * Start observing the DOM for new posts
   * @returns {MutationObserver}
   */
  function startObserver() {
    const obs = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          
          const element = node;
          
          // Check if parent is a feed
          const parent = element.parentElement;
          if (parent && parent.getAttribute('role') === 'feed') {
            processPost(element);
          }
          
          // Check if element contains a feed
          const feeds = element.querySelectorAll('[role="feed"]');
          for (const feed of feeds) {
            const posts = feed.children;
            for (const post of posts) {
              processPost(post);
            }
          }
        }
      }
    });
    
    obs.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    return obs;
  }

  // ============================================================================
  // PERIODIC RECHECK
  // ============================================================================

  /**
   * Periodically check for new posts and profile pages
   */
  function startPeriodicCheck() {
    setInterval(() => {
      // Process any new posts in feeds
      const feeds = document.querySelectorAll('[role="feed"]');
      for (const feed of feeds) {
        const posts = feed.children;
        for (const post of posts) {
          if (!processedPosts.has(post)) {
            processPost(post);
          }
        }
      }
      
      // Check if on profile page
      checkProfilePage();
    }, 3000);
  }

  // ============================================================================
  // MESSAGE HANDLING
  // ============================================================================

  /**
   * Handle messages from popup or background script
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      switch (message.type) {
        case 'feedfence:getStats':
          sendResponse({
            stats: stats,
            friendsCount: friendsList.size,
            mode: mode,
            enabled: enabled
          });
          return true;
        
        case 'feedfence:setEnabled':
          enabled = message.enabled;
          saveState();
          reprocessAll();
          sendResponse({ success: true });
          return true;
        
        case 'feedfence:setMode':
          mode = message.mode;
          saveState();
          reprocessAll();
          sendResponse({ success: true });
          return true;
        
        case 'feedfence:getFriends':
          const friendsArray = Array.from(friendsList).map(url => {
            // Find name for this URL
            let name = '';
            for (const [n, u] of friendNames.entries()) {
              if (u === url) {
                name = n;
                break;
              }
            }
            return { url, name };
          });
          friendsArray.sort((a, b) => a.name.localeCompare(b.name));
          sendResponse({ friends: friendsArray });
          return true;
        
        case 'feedfence:removeFriend':
          const urlToRemove = message.url;
          friendsList.delete(urlToRemove);
          // Remove from friendNames
          for (const [name, url] of friendNames.entries()) {
            if (url === urlToRemove) {
              friendNames.delete(name);
            }
          }
          saveState();
          reprocessAll();
          sendResponse({ success: true });
          return true;
        
        case 'feedfence:getSavedPosts':
          const postsToReturn = savedPosts.slice(0, 200);
          sendResponse({ posts: postsToReturn });
          return true;
        
        case 'feedfence:importFriends':
          autoImportFriendsFromPage();
          sendResponse({ success: true });
          return true;
        
        case 'feedfence:addFriend':
          const { name, url } = message;
          if (name && url) {
            friendsList.add(url);
            friendNames.set(name.toLowerCase(), url);
            saveState();
            reprocessAll();
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false });
          }
          return true;
        
        default:
          sendResponse({ error: 'Unknown message type' });
          return true;
      }
    } catch (error) {
      console.error('[FeedFence] Message handler error:', error);
      sendResponse({ error: error.message });
      return true;
    }
  });

  // ============================================================================
  // TOAST NOTIFICATIONS
  // ============================================================================

  /**
   * Show a toast notification
   * @param {string} message - The message to display
   */
  function showToast(message) {
    // Remove existing toast
    const existingToast = document.querySelector('.feedfence-toast');
    if (existingToast) {
      existingToast.remove();
    }
    
    // Create new toast
    const toast = document.createElement('div');
    toast.className = 'feedfence-toast';
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    // Remove after 4 seconds
    setTimeout(() => {
      toast.remove();
    }, 4000);
  }

  // ============================================================================
  // STATS BROADCAST
  // ============================================================================

  /**
   * Broadcast stats to popup or background script
   */
  function broadcastStats() {
    try {
      chrome.runtime.sendMessage({
        type: 'feedfence:stats',
        stats: stats
      });
    } catch (error) {
      // Silently fail - popup may not be open
    }
  }

  // ============================================================================
  // REPROCESS ALL
  // ============================================================================

  /**
   * Reprocess all posts (e.g., after settings change)
   */
  function reprocessAll() {
    // Reset state
    processedPosts = new WeakSet();
    stats.total = 0;
    stats.shown = 0;
    stats.hidden = 0;
    
    // Remove all existing peek bars
    const existingPeeks = document.querySelectorAll('.feedfence-peek');
    for (const peek of existingPeeks) {
      peek.remove();
    }
    
    // Get all posts and reprocess
    const feeds = document.querySelectorAll('[role="feed"]');
    for (const feed of feeds) {
      const posts = feed.children;
      for (const post of posts) {
        post.classList.remove('feedfence-shown', 'feedfence-hidden');
        processPost(post);
      }
    }
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Initialize the content script
   */
  async function init() {
    console.log('[FeedFence] Initializing...');
    
    // Load saved state
    await loadState();
    
    console.log('[FeedFence] State loaded:', {
      friends: friendsList.size,
      enabled: enabled,
      mode: mode,
      savedPosts: savedPosts.length
    });
    
    // Process existing posts
    const feeds = document.querySelectorAll('[role="feed"]');
    for (const feed of feeds) {
      const posts = feed.children;
      for (const post of posts) {
        processPost(post);
      }
    }
    
    // Start observing for new posts
    observer = startObserver();
    
    // Start periodic check
    startPeriodicCheck();
    
    // Check if on profile or friends page
    checkProfilePage();
    checkFriendsPage();
    
    // Show activation toast
    showToast('FeedFence is active! 🛡️');
    
    console.log('[FeedFence] Initialization complete');
  }

  // Start the extension
  init();

})();
