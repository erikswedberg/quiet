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
      console.error('[Quiet] Failed to load state:', error);
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

  // ============================================================================
  // POST CLASSIFICATION
  // ============================================================================

  /**
   * Check if a post is sponsored
   * @param {Element} postEl - The post element
   * @returns {boolean}
   */
  function isSponsored(postEl) {
    // Any data-ad-rendering-role attribute is an ad marker
    if (postEl.querySelector('[data-ad-rendering-role]')) return true;
    // Links to external sites via l.facebook.com redirect (ad click-throughs)
    if (postEl.querySelector('a[href*="l.facebook.com/l.php"]')) return true;
    // "Sponsored" text as a visible label (can be in span or a)
    // Check links first -- Facebook wraps "Sponsored" in a link to /ads/about
    const adLinks = postEl.querySelectorAll('a[href*="ads/about"], a[href*="ad_preferences"]');
    if (adLinks.length > 0) return true;
    // Also check for the exact text "Sponsored" in leaf spans/links
    const els = postEl.querySelectorAll('span, a');
    for (const el of els) {
      const text = el.textContent.trim();
      if (text === 'Sponsored') return true;
    }
    // CTA buttons that only appear in ads (conservative list)
    const links = postEl.querySelectorAll('a[role="link"]');
    const ctaPatterns = ['Learn more', 'Shop now', 'Sign up', 'Install now', 'Book now', 'Get offer', 'Apply now', 'Get quote'];
    for (const link of links) {
      const text = link.textContent.trim();
      for (const cta of ctaPatterns) {
        if (text === cta) return true;
      }
    }
    return false;
  }

  /**
   * Check if a post is suggested content
   * @param {Element} postEl - The post element
   * @returns {boolean}
   */
  function isSuggested(postEl) {
    // Explicit "Suggested for you" type labels
    const suggestedPhrases = [
      'Suggested for you',
      'People you may know',
      'Reels and short videos',
      'Join this group',
      'Popular near you',
      'Related discussions'
    ];
    
    const spans = postEl.querySelectorAll('span');
    for (const span of spans) {
      const text = span.textContent.trim();
      for (const phrase of suggestedPhrases) {
        if (text === phrase) {
          return true;
        }
      }
    }
    
    // "Follow" link in the post header indicates a page/profile you don't follow.
    // Facebook shows " · Follow" right next to the author name for unfollowed pages.
    // Check for a[role="link"] or span containing exactly "Follow" near the top of the post.
    const links = postEl.querySelectorAll('a[role="link"], span[role="link"], div[role="button"]');
    for (const link of links) {
      const text = link.textContent.trim();
      if (text === 'Follow') {
        // Make sure it's in the header area (near the avatar), not in a comment or reaction
        const linkRect = link.getBoundingClientRect();
        const avatar = postEl.querySelector('svg[role="img"][aria-label]');
        if (avatar) {
          const avatarRect = avatar.getBoundingClientRect();
          // "Follow" should be within ~150px vertically of the avatar (in the header)
          if (Math.abs(linkRect.top - avatarRect.top) < 150) {
            return true;
          }
        }
        // Fallback: if there's no avatar found, still flag it if it looks like a header Follow
        // The Follow link in headers is typically near the top of the post
        const postRect = postEl.getBoundingClientRect();
        if (linkRect.top - postRect.top < 200) {
          return true;
        }
      }
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
  // ============================================================================
  // PEEK BARS
  // ============================================================================

  /**
   * Inject a peek bar for a hidden post
   * @param {Element} postEl - The hidden post element
   */
  function injectPeekBar(postEl, authorName, authorUrl) {
    if (postEl.querySelector('.quiet-peek')) return;

    const peekBar = document.createElement('div');
    peekBar.className = 'quiet-peek';

    const label = document.createElement('span');
    label.className = 'quiet-peek-label';
    label.textContent = 'Hidden:';

    const authorSpan = document.createElement('span');
    authorSpan.className = 'quiet-peek-author';
    authorSpan.textContent = authorName || 'Unknown';

    const addButton = document.createElement('button');
    addButton.className = 'quiet-peek-add';
    addButton.textContent = '+ Add';

    const showButton = document.createElement('button');
    showButton.className = 'quiet-peek-show';
    showButton.textContent = 'Show once';

    addButton.addEventListener('click', (e) => {
      e.stopPropagation();
      if (authorUrl) {
        friendsList.add(authorUrl);
        friendNames.set(authorName.toLowerCase(), authorUrl);
        saveState();
        showToast('Added ' + authorName);
        reprocessAll();
      }
    });

    showButton.addEventListener('click', (e) => {
      e.stopPropagation();
      postEl.classList.remove('quiet-hidden');
      peekBar.remove();
    });

    peekBar.appendChild(label);
    peekBar.appendChild(authorSpan);
    if (authorUrl) peekBar.appendChild(addButton);
    peekBar.appendChild(showButton);

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
      // Sanity check: a post container should not be enormous.
      // If it contains more than a handful of data-virtualized children,
      // it's a feed wrapper, not a single post.
      const virtChildren = candidate.querySelectorAll('[data-virtualized]');
      if (virtChildren.length > 3) {
        // This is a feed-level container, not a post. Reject it.
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
      if (!container) continue;
      
      let profileUrl = normalizeProfileUrl(href);
      
      // If the avatar links to /stories/, we got a profile:ID from the story URL.
      // But the user's friend list stores user:username keys.
      // Try to find a direct profile link nearby in the post header for a better match.
      if (!profileUrl || profileUrl.startsWith('profile:')) {
        const betterUrl = findProfileLinkInHeader(container, name);
        if (betterUrl) profileUrl = betterUrl;
      }
      
      if (!profileUrl) continue;
      
      // Skip if already processed
      if (processedPosts.has(container)) continue;
      
      results.push({ container, authorName: name, profileUrl });
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
      const sponsored = isSponsored(container);
      const suggested = isSuggested(container);
      
      if (sponsored || suggested) {
        container.classList.add('quiet-hidden');
        container.classList.remove('quiet-shown');
        stats.hidden++;
        injectPeekBar(container, 'Sponsored/Suggested', null);
      } else if (mode === 'friends' && !isFriend) {
        container.classList.add('quiet-hidden');
        container.classList.remove('quiet-shown');
        stats.hidden++;
        injectPeekBar(container, authorName, profileUrl);
      } else if (mode === 'groups' && !isGroupPost(container)) {
        container.classList.add('quiet-hidden');
        container.classList.remove('quiet-shown');
        stats.hidden++;
        injectPeekBar(container, authorName, profileUrl);
      } else {
        container.classList.add('quiet-shown');
        container.classList.remove('quiet-hidden');
        stats.shown++;
        savePost(container, { name: authorName, profileUrl });
      }
      
      broadcastStats();
    }
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
        case 'quiet:getStats':
          sendResponse({
            stats: stats,
            friendsCount: friendsList.size,
            mode: mode,
            enabled: enabled
          });
          return true;
        
        case 'quiet:setEnabled':
          enabled = message.enabled;
          saveState();
          reprocessAll();
          sendResponse({ success: true });
          return true;
        
        case 'quiet:setMode':
          mode = message.mode;
          saveState();
          reprocessAll();
          sendResponse({ success: true });
          return true;
        
        case 'quiet:getFriends':
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
        
        case 'quiet:removeFriend':
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
        
        case 'quiet:getSavedPosts':
          const postsToReturn = savedPosts.slice(0, 200);
          sendResponse({ posts: postsToReturn });
          return true;
        
        case 'quiet:importFriends':
          autoImportFriendsFromPage();
          sendResponse({ success: true });
          return true;
        
        case 'quiet:addFriend':
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
      console.error('[Quiet] Message handler error:', error);
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
  function reprocessAll() {
    processedPosts = new WeakSet();
    stats.total = 0;
    stats.shown = 0;
    stats.hidden = 0;

    // Remove all peek bars and classes
    document.querySelectorAll('.quiet-peek').forEach(p => p.remove());
    document.querySelectorAll('.quiet-hidden').forEach(el => el.classList.remove('quiet-hidden'));
    document.querySelectorAll('.quiet-shown').forEach(el => el.classList.remove('quiet-shown'));

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
    
    // Initial scan
    scanAndFilter();
    
    // Start observing for new posts
    observer = startObserver();
    
    // Start periodic check
    startPeriodicCheck();
    
    // Check if on profile or friends page
    checkProfilePage();
    checkFriendsPage();
    
    // Show activation toast
    showToast('Quiet is active.');
    
    console.log('[Quiet] Initialization complete');
  }

  // Start the extension
  init();

})();
