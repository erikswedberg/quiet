# Quiet

Turn social media into RSS. Only see posts from people you actually know.

Quiet is a Chrome extension that filters your social media feeds to only show posts from people you explicitly add to your list. Everything else - sponsored content, suggested posts, algorithmic noise - gets hidden.

Currently supports Facebook. Instagram is next.

## Philosophy

Social media should work like RSS: you subscribe to people, you see their posts, in order. No algorithm deciding what you see. No "suggested for you." No sponsored content wedged between posts from people you care about.

Quiet short-circuits the algorithm and gives you back a chronological feed of just your people.

## How it works

1. Install the extension (see below)
2. Build your list by visiting your friends/following page and clicking Import
3. Browse normally - Quiet hides everything not from your people
4. See peek bars for hidden posts - quickly add someone from the feed itself
5. View your timeline - a clean, chronological view of saved posts

## Features

- Feed filtering: hides posts from people not in your list, sponsored content, and suggested posts
- Peek bars: hidden posts collapse to a single line with the author name, Add and Show Once buttons
- Bulk import from your friends/following page
- Profile page detection: visit someone's profile > banner to add them
- Timeline view: saved posts displayed chronologically
- Badge counter on the extension icon showing how many posts were hidden
- Modes: Friends only, Groups only, or Off
- 100% client-side. Nothing leaves your browser. No accounts, no servers, no tracking.

## Installation

1. Clone or download this repo
2. Open Chrome > chrome://extensions/
3. Enable Developer mode (top right)
4. Click Load unpacked
5. Select this folder

## Getting started (Facebook)

1. After installing, go to facebook.com/friends/list
2. Click the Quiet icon > Import Friends
3. Scroll down the friends page to load more (Quiet scans every 2 seconds for 60 seconds)
4. Go to your news feed - only posts from imported friends will show
5. Use peek bars to add anyone you missed

## Future

- Instagram support
- Round-robin profile visiting to build a self-aggregated feed
- Better timestamp parsing
- Export as actual RSS/Atom XML

## Architecture

```
manifest.json     - Chrome extension manifest (MV3)
content.js        - Core: MutationObserver, author extraction, filtering, peek bars
content.css       - Styles injected into pages
background.js     - Service worker: storage init, badge updates, alarms
popup.html/js     - Extension popup: stats, controls, list management
timeline.html     - Standalone chronological timeline viewer
icons/            - Extension icons
```

## Technical notes

- Author detection uses aria-label on profile photo links (most stable selector on Facebook)
- Falls back to h2/h3/h4 header links
- Facebook obfuscates class names but role attributes and ARIA labels are stable
- MutationObserver catches infinite-scroll posts; periodic recheck (3s) catches DOM rearrangements
- People stored in chrome.storage.local as normalized keys (user:username or profile:12345)

## License

Personal use.
