/**
 * Quiet - Facebook News Feed Filter
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
  let friendNames = new Map();        // Lowercase display name to profile URL key
  let groupsList = new Set();         // Group URL keys: "group:12345" or "group:slug"
  let groupNames = new Map();         // Lowercase display name to group URL key
  let enabled = true;                 // Whether filtering is active
  let mode = 'friends';               // 'friends' | 'groups' | 'off'
  let stats = {                       // Statistics
    total: 0,
    shown: 0,
    hidden: 0
  };
  let processedPosts = new WeakSet(); // Track which posts we've already processed
  let savedPosts = [];                // Array of saved post objects
  const STORAGE_KEY = 'quiet';    // Key for chrome.storage.local

  let observer = null;                // MutationObserver instance
  let saveStateTimeout = null;        // Debounce timer for saving state

  // Resolves once loadState() finishes. Handlers that mutate state
  // await this to avoid clobbering storage with empty data.
  let resolveStateReady;
  const stateReady = new Promise(r => { resolveStateReady = r; });


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
        
        // Load groups list
        if (Array.isArray(data.groupsList)) {
          groupsList = new Set(data.groupsList);
        }
        
        // Load group names map
        if (data.groupNames && typeof data.groupNames === 'object') {
          groupNames = new Map(Object.entries(data.groupNames));
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
      console.error('[Quiet] Failed to load state:', error);
    } finally {
      console.log('[Quiet] loadState complete. friends:', friendsList.size, 'groups:', groupsList.size);
      resolveStateReady();
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
        groupsList: Array.from(groupsList),
        groupNames: Object.fromEntries(groupNames),
        enabled: enabled,
        mode: mode,
        savedPosts: savedPosts
      };
      
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
    } catch (error) {
      console.error('[Quiet] Failed to save state:', error);
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
      
      // Handle /stories/NUMERIC_ID/... -- avatar links to stories when user has active story
      if (url.pathname.startsWith('/stories/')) {
        const storyParts = url.pathname.split('/').filter(p => p.length > 0);
        // /stories/NUMERIC_ID/...
        if (storyParts.length >= 2 && /^\d+$/.test(storyParts[1])) {
          return `profile:${storyParts[1]}`;
        }
      }
      
      // Handle /groups/GROUPID/user/USERID/ format (group post avatar links)
      const groupUserMatch = url.pathname.match(/^\/groups\/[^/]+\/user\/(\d+)/);
      if (groupUserMatch) {
        return `profile:${groupUserMatch[1]}`;
      }

      // Skip certain paths that aren't profiles
      const skipPaths = [
        '/watch', '/marketplace', '/groups', '/events',
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
  // AUTHOR EXTRACTION (legacy, kept for savePost)
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

  /**
   * Normalize a group URL to a storage key.
   * Returns "group:ID" or "group:slug" or null.
   */
  function normalizeGroupUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(href, 'https://www.facebook.com');
      // /groups/SLUG/ or /groups/NUMERICID/
      const match = url.pathname.match(/^\/groups\/([^/]+)/);
      if (match && match[1] && match[1] !== 'feed' && match[1] !== 'joins' && match[1] !== 'discover') {
        return `group:${match[1]}`;
      }
    } catch (e) {}
    return null;
  }

  /**
   * Check if a post is from a group the user has joined.
   * Returns the group key if found, null otherwise.
   */
  function getPostGroupKey(postEl) {
    const groupLinks = postEl.querySelectorAll('a[href*="/groups/"]');
    for (const link of groupLinks) {
      const key = normalizeGroupUrl(link.getAttribute('href'));
      if (key && groupsList.has(key)) return key;
    }
    return null;
  }

  /**
   * Search a post for any profile link that belongs to a friend.
   * Used to detect friend shares/reposts where the avatar is the original author.
   */
  function findFriendInPost(postEl) {
    const links = postEl.querySelectorAll('a[role="link"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const key = normalizeProfileUrl(href);
      if (key && friendsList.has(key)) {
        // Get the friend's display name from our stored names
        let name = '';
        for (const [n, u] of friendNames.entries()) {
          if (u === key) { name = n; break; }
        }
        // Capitalize stored lowercase name
        if (name) {
          name = name.replace(/\b\w/g, c => c.toUpperCase());
        }
        return { url: key, name };
      }
    }
    return null;
  }

  /**
   * Inject a small label at the top of a shared post showing who shared it.
   */
  function injectShareLabel(postEl, sharerName, originalAuthor) {
    if (postEl.querySelector('.quiet-share-label')) return;

    postEl.classList.add('quiet-shared', 'quiet-collapsed');

    const label = document.createElement('div');
    label.className = 'quiet-share-label';
    label.textContent = sharerName + ' shared a post from ' + originalAuthor;
    label.addEventListener('click', () => {
      postEl.classList.remove('quiet-collapsed');
    });

    const collapseBtn = document.createElement('div');
    collapseBtn.className = 'quiet-collapse-btn';
    collapseBtn.textContent = '\u2039 Collapse';
    collapseBtn.addEventListener('click', () => {
      postEl.classList.add('quiet-collapsed');
    });

    postEl.insertBefore(collapseBtn, postEl.firstChild);
    postEl.insertBefore(label, postEl.firstChild);
  }

  // ============================================================================
  // CORE FILTER LOGIC
  // ============================================================================

  /**
  // ============================================================================
  // PEEK BARS
  // ============================================================================

  /**
   * Inject a peek bar for a hidden post
   * @param {Element} postEl - The hidden post element
   */


  // ============================================================================
  // FRIENDS PAGE IMPORT
  // ============================================================================

  /**
   * Check if we're on the friends page and extract friends
   * @returns {number} - Number of friends found
   */
  function checkFriendsPage() {
    // Only run on the actual friends list page, not /friends (which is requests)
    if (!window.location.pathname.includes('/friends/list')) {
      return 0;
    }
    
    let count = 0;

    // Each friend row on /friends/list is:
    //   div[data-visualcompletion="ignore-dynamic"]
    //     > a[role="link"][href="https://www.facebook.com/username"]
    //       > div > div > (svg with profile photo) + (div with name)
    // The name lives in the first span[dir="auto"] inside the link.
    const rows = document.querySelectorAll('div[data-visualcompletion="ignore-dynamic"]');
    console.log('[Quiet] Scanning ' + rows.length + ' rows on friends/list');

    for (const row of rows) {
      const link = row.querySelector('a[role="link"]');
      if (!link) continue;

      const href = link.getAttribute('href');
      if (!href) continue;

      const profileUrl = normalizeProfileUrl(href);
      if (!profileUrl || friendsList.has(profileUrl)) continue;

      // The name is in the first span[dir="auto"] inside the link.
      // Its direct text (via innermost span) is the person's name.
      const nameSpan = link.querySelector('span[dir="auto"]');
      if (!nameSpan) continue;

      // Get the deepest text - walk to the innermost span
      let nameEl = nameSpan;
      while (nameEl.querySelector('span')) {
        nameEl = nameEl.querySelector('span');
      }
      const name = nameEl.textContent.trim();

      if (!name || name.length < 2 || name.length > 80) continue;
      // Skip if this is "X mutual friends" or other non-name text
      if (name.includes('mutual friend')) continue;

      friendsList.add(profileUrl);
      friendNames.set(name.toLowerCase(), profileUrl);
      count++;
      console.log('[Quiet] Found friend: ' + name + ' -> ' + profileUrl);
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
    if (!window.location.pathname.includes('/friends/list')) {
      showToast('Please navigate to facebook.com/friends/list first');
      return;
    }
    
    showToast('Scanning for friends...');
    
    let intervalCount = 0;
    const maxIntervals = 30; // 30 intervals * 2s = 60 seconds
    
    const importInterval = setInterval(() => {
      const newCount = checkFriendsPage();
      intervalCount++;
      
      if (newCount > 0) {
        showToast(friendsList.size + ' friends total. Keep scrolling.');
      }
      
      // Stop after 60 seconds
      if (intervalCount >= maxIntervals) {
        clearInterval(importInterval);
        showToast('Import done. ' + friendsList.size + ' friends.');
      }
    }, 2000);
  }

  // ============================================================================
  // GROUP IMPORT
  // ============================================================================

  /**
   * Scan /groups/joins/ page for joined groups.
   * Each group card has a link like /groups/SLUG/ or /groups/ID/
   * and the group name as text.
   */
  function checkGroupsPage() {
    if (!window.location.pathname.includes('/groups/joins')) {
      return 0;
    }

    let count = 0;

    // Group cards contain links to /groups/SLUG with "View group" button.
    // Find all links that go to a specific group.
    const links = document.querySelectorAll('a[href*="/groups/"]');

    for (const link of links) {
      const href = link.getAttribute('href');
      const groupKey = normalizeGroupUrl(href);
      if (!groupKey || groupsList.has(groupKey)) continue;

      // The group name is typically in a nearby heading or strong text.
      // Walk up to the card container and look for the name.
      const card = link.closest('[role="listitem"]') || link.closest('div[class]');
      if (!card) continue;

      // Try to find the group name: look for spans with short text
      // that aren't "View group" or "Last active" etc.
      let name = '';
      const spans = card.querySelectorAll('span');
      for (const span of spans) {
        const text = span.textContent.trim();
        if (text.length >= 3 && text.length <= 120 &&
            !text.startsWith('View group') &&
            !text.startsWith('Last') &&
            !text.startsWith('You last') &&
            !text.includes('member') &&
            !text.includes('post')) {
          // Prefer the longest meaningful text (likely the full group name)
          if (text.length > name.length) {
            name = text;
          }
        }
      }

      if (!name || name.length < 3) continue;

      groupsList.add(groupKey);
      groupNames.set(name.toLowerCase(), groupKey);
      count++;
      console.log('[Quiet] Found group: ' + name + ' -> ' + groupKey);
    }

    if (count > 0) {
      saveState();
    }

    return count;
  }

  /**
   * Auto-import groups with scroll + progress updates
   */
  function autoImportGroupsFromPage() {
    if (!window.location.pathname.includes('/groups/joins')) {
      showToast('Please navigate to facebook.com/groups/joins first');
      return;
    }

    showToast('Scanning for groups...');

    let intervalCount = 0;
    const maxIntervals = 30;

    const importInterval = setInterval(() => {
      const newCount = checkGroupsPage();
      intervalCount++;

      if (newCount > 0) {
        showToast(groupsList.size + ' groups total. Keep scrolling.');
      }

      if (intervalCount >= maxIntervals) {
        clearInterval(importInterval);
        showToast('Import done. ' + groupsList.size + ' groups.');
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
    if (document.querySelector('.quiet-profile-banner')) {
      return;
    }
    
    // Create banner
    const banner = document.createElement('div');
    banner.className = 'quiet-profile-banner';
    banner.innerHTML = `
      <div class="quiet-profile-banner-content">
        <span class="quiet-profile-banner-icon">Quiet</span>
        <span class="quiet-profile-banner-text">Add <strong>${name}</strong> to Quiet?</span>
        <button class="quiet-profile-banner-add">Add Friend</button>
        <button class="quiet-profile-banner-dismiss">Dismiss</button>
      </div>
    `;
    
    // Add button handler
    const addButton = banner.querySelector('.quiet-profile-banner-add');
    addButton.addEventListener('click', () => {
      friendsList.add(profileUrl);
      friendNames.set(name.toLowerCase(), profileUrl);
      saveState();
      showToast(`Added ${name} to friends list`);
      banner.remove();
    });
    
    // Dismiss button handler
    const dismissButton = banner.querySelector('.quiet-profile-banner-dismiss');
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
  // POST DISCOVERY
  // ============================================================================

  // Facebook no longer uses [role="feed"]. Posts are virtualized divs.
  // Each post has a profile avatar: svg[role="img"][aria-label="PersonName"]
  // We find these, walk up to the post container, and process from there.

  /**
   * Find the post container element by walking up from an element inside it.
   * The post boundary is the div with data-virtualized="false", or if not found,
   * a high-level div that contains the Like/Comment/Share buttons.
   */
  function findProfileLinkInHeader(container, authorName) {
    // Look for a[role="link"] that links to a profile (not stories/photos/etc)
    // and whose text matches the author name
    const links = container.querySelectorAll('a[role="link"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const normalized = normalizeProfileUrl(href);
      if (!normalized) continue;
      // Prefer links whose visible text matches the author name
      const text = link.textContent.trim();
      if (text === authorName) return normalized;
    }
    // If no exact name match, return the first valid profile link
    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const normalized = normalizeProfileUrl(href);
      if (normalized && normalized.startsWith('user:')) return normalized;
    }
    return null;
  }

  function findPostContainer(el) {
    let node = el;
    let candidate = null;
    // Walk up looking for data-virtualized, but pick the INNERMOST one
    // that's a reasonable post size (not a page-level wrapper)
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute('data-virtualized') === 'false') {
        candidate = node;
        break;
      }
      node = node.parentElement;
    }
    if (candidate) {
      // Sanity check: reject feed-level wrappers
      const virtChildren = candidate.querySelectorAll('[data-virtualized]');
      if (virtChildren.length > 3) {
        candidate = null;
      }
      // Must look like a post (has Like/Comment interaction buttons)
      if (candidate && !candidate.querySelector('[aria-label="Like"]')) {
        candidate = null;
      }
    }
    if (candidate) return candidate;
    
    // Fallback: walk up from the avatar link to find a container that has
    // Like/Comment/Share buttons, meaning it wraps a full post
    node = el;
    while (node && node !== document.body) {
      if (node.querySelector && 
          node.querySelector('[aria-label="Like"]') &&
          node.querySelector('[aria-label="Leave a comment"]')) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Scan the page for all posts by finding profile avatar SVGs.
   * Returns an array of { container, authorName, profileUrl }.
   */
  function discoverPosts() {
    const results = [];
    // Find all profile avatar SVGs in posts
    const avatars = document.querySelectorAll('svg[role="img"][aria-label]');
    
    for (const svg of avatars) {
      let name = svg.getAttribute('aria-label');
      if (!name || name.length < 2 || name.length > 80) continue;
      
      // Strip ", view story" suffix that Facebook adds when user has active stories
      name = name.replace(/, view story$/i, '').trim();
      if (!name) continue;
      
      // The svg is inside an a[role="link"] that links to the profile
      const link = svg.closest('a[role="link"]');
      if (!link) continue;
      
      const href = link.getAttribute('href');
      if (!href) continue;
      
      // Find the post container first (needed for fallback profile link search too)
      const container = findPostContainer(svg);
      if (!container) {
        console.log('[Quiet] No container for:', name, href.substring(0, 60));
        continue;
      }
      
      let profileUrl = normalizeProfileUrl(href);
      
      // If the avatar links to /stories/, we got a profile:ID from the story URL.
      // But the user's friend list stores user:username keys.
      // Try to find a direct profile link nearby in the post header for a better match.
      if (!profileUrl || profileUrl.startsWith('profile:')) {
        const betterUrl = findProfileLinkInHeader(container, name);
        if (betterUrl) profileUrl = betterUrl;
      }
      
      if (!profileUrl) {
        console.log('[Quiet] No profileUrl for:', name, href.substring(0, 60));
      }
      
      // Skip if already processed
      if (processedPosts.has(container)) continue;
      
      results.push({ container, authorName: name, profileUrl: profileUrl || '' });
    }
    
    return results;
  }

  // ============================================================================
  // MUTATION OBSERVER
  // ============================================================================

  function startObserver() {
    const obs = new MutationObserver(() => {
      // Debounce: Facebook mutates DOM rapidly
      clearTimeout(startObserver._timer);
      startObserver._timer = setTimeout(() => {
        scanAndFilter();
      }, 500);
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

  function startPeriodicCheck() {
    setInterval(() => {
      scanAndFilter();
      checkProfilePage();

      if (window.location.pathname.includes('/friends/list')) {
        const found = checkFriendsPage();
        if (found > 0) {
          showToast(friendsList.size + ' friends total.');
        }
      }

      if (window.location.pathname.includes('/groups/joins')) {
        const found = checkGroupsPage();
        if (found > 0) {
          showToast(groupsList.size + ' groups total.');
        }
      }
    }, 3000);
  }

  /**
   * Main scan loop: discover posts, filter them.
   */
  function scanAndFilter() {
    if (!enabled) return;
    
    const posts = discoverPosts();
    
    for (const { container, authorName, profileUrl } of posts) {
      processedPosts.add(container);
      stats.total++;
      
      const isFriend = friendsList.has(profileUrl);
      const groupKey = getPostGroupKey(container);
      
      // Classify the post
      container.classList.remove('quiet-friend', 'quiet-group', 'quiet-other');
      if (isFriend) {
        container.classList.add('quiet-friend');
        stats.shown++;
        console.log('[Quiet] Post:', authorName, '->', profileUrl, 'FRIEND');
        savePost(container, { name: authorName, profileUrl, type: 'friend' });
      } else if (groupKey) {
        container.classList.add('quiet-group');
        stats.shown++;
        console.log('[Quiet] Post:', authorName, '->', profileUrl, 'GROUP', groupKey, 'display:', window.getComputedStyle(container).display);
        savePost(container, { name: authorName, profileUrl, type: 'group', groupKey });
      } else {
        // Check if a friend shared this (friend's profile link somewhere in the post)
        const sharer = findFriendInPost(container);
        if (sharer) {
          container.classList.add('quiet-friend');
          stats.shown++;
          injectShareLabel(container, sharer.name, authorName);
          savePost(container, { name: sharer.name, profileUrl: sharer.url, type: 'friend' });
        } else {
          container.classList.add('quiet-other');
          stats.hidden++;
          console.log('[Quiet] Post:', authorName, '->', profileUrl, 'OTHER');
        }
      }

      broadcastStats();
    }
  }

  // ============================================================================
  // MESSAGE HANDLING
  // ============================================================================

  /**
   * Handle messages from popup or background script.
   * Read-only handlers respond synchronously.
   * Mutation handlers await stateReady to avoid clobbering storage.
   */
  async function handleMutation(message) {
    await stateReady;

    switch (message.type) {
      case 'quiet:setEnabled':
        enabled = message.enabled;
        saveState();
        reprocessAll();
        return { success: true };

      case 'quiet:setMode':
        mode = message.mode;
        saveState();
        applyViewMode();
        return { success: true };

      case 'quiet:removeFriend': {
        const urlToRemove = message.url;
        friendsList.delete(urlToRemove);
        for (const [name, url] of friendNames.entries()) {
          if (url === urlToRemove) {
            friendNames.delete(name);
          }
        }
        saveState();
        reprocessAll();
        return { success: true };
      }

      case 'quiet:clearFriends':
        friendsList.clear();
        friendNames.clear();
        saveState();
        reprocessAll();
        return { success: true };

      case 'quiet:addFriend': {
        const { name, url } = message;
        if (name && url) {
          friendsList.add(url);
          friendNames.set(name.toLowerCase(), url);
          saveState();
          reprocessAll();
          return { success: true };
        }
        return { success: false };
      }

      case 'quiet:importFriends':
        autoImportFriendsFromPage();
        return { success: true };

      case 'quiet:importGroups':
        autoImportGroupsFromPage();
        return { success: true };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Read-only: respond synchronously
    switch (message.type) {
      case 'quiet:getStats':
        sendResponse({
          stats: stats,
          friendsCount: friendsList.size,
          groupsCount: groupsList.size,
          mode: mode,
          enabled: enabled
        });
        return;

      case 'quiet:getSavedPosts':
        sendResponse({ posts: savedPosts.slice(0, 200) });
        return;
    }

    // Mutations: await stateReady, then respond
    handleMutation(message)
      .then(response => sendResponse(response || { error: 'Unknown message type' }))
      .catch(err => {
        console.error('[Quiet] Message handler error:', err);
        sendResponse({ error: err.message });
      });
    return true; // Keep channel open for async response
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
    const existingToast = document.querySelector('.quiet-toast');
    if (existingToast) {
      existingToast.remove();
    }
    
    // Create new toast
    const toast = document.createElement('div');
    toast.className = 'quiet-toast';
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
        type: 'quiet:stats',
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
  /**
   * Apply the current view mode to <body> so CSS handles visibility.
   */
  function applyViewMode() {
    document.body.classList.add('quiet-active');
    document.body.classList.remove('quiet-view-friends', 'quiet-view-groups', 'quiet-view-off');
    if (enabled) {
      document.body.classList.add('quiet-view-' + mode);
    } else {
      document.body.classList.remove('quiet-active');
      document.body.classList.add('quiet-view-off');
    }
  }

  function reprocessAll() {
    processedPosts = new WeakSet();
    stats.total = 0;
    stats.shown = 0;
    stats.hidden = 0;

    // Remove all peek bars and classes

    document.querySelectorAll('.quiet-friend, .quiet-group, .quiet-other').forEach(el => {
      el.classList.remove('quiet-friend', 'quiet-group', 'quiet-other');
    });

    applyViewMode();

    // Re-scan
    scanAndFilter();
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Initialize the content script
   */
  async function init() {
    console.log('[Quiet] Initializing...');
    
    // Load saved state
    await loadState();
    
    console.log('[Quiet] State loaded:', {
      friends: friendsList.size,
      enabled: enabled,
      mode: mode,
      savedPosts: savedPosts.length
    });
    
    // Set view mode on body
    applyViewMode();
    
    // Initial scan
    scanAndFilter();
    
    // Start observing for new posts
    observer = startObserver();
    
    // Start periodic check
    startPeriodicCheck();
    
    // Check if on profile or friends page
    checkProfilePage();
    checkFriendsPage();
    checkGroupsPage();
    
    // Show activation toast
    showToast('Quiet is active.');
    
    console.log('[Quiet] Initialization complete');
  }

  // Start the extension
  init();

})();
