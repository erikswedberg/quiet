# 🛡️ FeedFence

**Turn Facebook into an RSS feed.** Only see posts from people you actually care about.

FeedFence is a Chrome extension that filters your Facebook news feed to only show posts from friends you explicitly add to your list. Everything else — sponsored content, suggested posts, algorithmic garbage, murder videos, prom photos from strangers — gets hidden.

## Philosophy

Social media should work like RSS: you subscribe to people, you see their posts, in order. No algorithm deciding what you see. No "suggested for you." No sponsored content wedged between your mom's vacation photos.

FeedFence short-circuits Facebook's algorithm and gives you back a chronological feed of just your people.

## How it works

1. **Install the extension** (see below)
2. **Build your friends list** by visiting `facebook.com/friends` and clicking "Import Friends" in the popup
3. **Browse Facebook normally** — FeedFence hides everything not from your friends
4. **See peek bars** for hidden posts — quickly add new friends from the feed itself
5. **View your timeline** — a clean, chronological view of saved posts

## Features

- **Feed filtering**: Hides posts from non-friends, sponsored content, and suggested posts
- **Peek bars**: Hidden posts show a compact bar with the author name + "Add" / "Show once" buttons
- **Friends import**: Bulk import from your Facebook friends page
- **Profile detection**: Visit a friend's profile → banner to add them
- **Timeline view**: Saved posts displayed chronologically (the way it should be)
- **Badge counter**: Extension icon shows how many posts were hidden
- **Modes**: Friends only, Groups only, or Off
- **100% client-side**: Nothing leaves your browser. No accounts, no servers, no tracking.

## Installation

This is a personal tool, not on the Chrome Web Store.

1. Clone/download this repo
2. Open Chrome → `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked"
5. Select the `facebook-rss-ext` folder
6. Navigate to Facebook — you'll see the FeedFence toast

## Getting started

1. After installing, go to [facebook.com/friends/list](https://www.facebook.com/friends/list)
2. Click the FeedFence icon → "Import Friends"
3. Scroll down the friends page to load more (FeedFence scans every 2 seconds for 60 seconds)
4. Go to your news feed — only posts from imported friends will show
5. Use peek bars to add anyone you missed

## Future plans

- **Round-robin friend visiting**: Passively check friends' profiles once/day to build a self-aggregated feed
- **Instagram support**: Same concept, different site
- **Better timestamps**: Parse Facebook's relative timestamps into real dates
- **Export**: Export your clean timeline as actual RSS/Atom XML

## Architecture

```
manifest.json     — Chrome extension manifest (MV3)
content.js        — Core: MutationObserver, author extraction, filtering, peek bars
content.css       — Styles injected into Facebook pages
background.js     — Service worker: storage init, badge updates, alarms
popup.html/js     — Extension popup: stats, controls, friend management
timeline.html     — Standalone chronological timeline viewer
icons/            — Extension icons (shield + RSS symbol)
```

## Technical notes

- Author detection uses `aria-label` on profile photo links (most stable selector)
- Falls back to `h2/h3/h4 > a[role="link"]` header links
- Facebook obfuscates class names but `[role="feed"]`, `[role="link"]`, and ARIA attributes are stable
- MutationObserver catches infinite-scroll posts; periodic recheck (3s) catches DOM rearrangements
- Friends stored in `chrome.storage.local` as normalized keys (`user:username` or `profile:12345`)

## License

Personal use. Don't get 86'd by Zuck.
