# Findtube

A YouTube-style web app. The server reads YouTube's own data directly, and
videos play in YouTube's privacy-enhanced player (`youtube-nocookie.com`).
No Invidious or Piped instances are involved.

## Features

- **Home**: videos related to what you watched recently, like YouTube's own
  recommendations. First-time visitors see this week's popular videos.
  Topic chips cover Music, Gaming, News and more.
- **Search**: suggestions as you type, All/Videos/Channels tabs, filters
  (sort, upload date, duration) and infinite scroll.
- **Watch page**:
  - Player, title, channel (avatar, subscriber count, Subscribe button),
    likes, Share and an expandable description.
  - Links, `1:23` timestamps (they seek the player without reloading it) and
    #hashtags in the description are clickable.
  - An endless column of related videos.
  - When a video ends, the next related video can play automatically.
- **Comments**: Top or Newest sorting, pinned and creator-hearted badges,
  threaded replies, and "Read more" for long comments.
- **Channel pages**: banner, avatar, @handle, subscriber and video counts,
  Videos and About tabs.
- **Subscriptions and history**: stored in your browser. Subscribed channels
  appear in the sidebar, and a feed merges their latest uploads.
- **Navigation and layout**: Back and Forward restore pages instantly at the
  same scroll position. Light and dark themes follow your OS, the layout
  works on phones, and `/` focuses the search box.

## How it works

```
browser ──► Findtube server ──► YouTube's internal API (InnerTube)
   │          /api/*  search, video details, related, comments, channels
   │
   ├──► www.youtube-nocookie.com   embedded player (video plays in the browser)
   └──► i.ytimg.com, yt3.ggpht.com thumbnails and avatars
```

- **`server/youtube.js`**: uses [youtubei.js](https://github.com/LuanRT/YouTube.js)
  to call InnerTube, the JSON API that youtube.com itself uses. It calls the
  `search`, `next` (video page, related videos, comments) and `browse`
  (channels) endpoints, then converts the results into small, stable shapes
  for the frontend. Requests go to `youtubei.googleapis.com`, which is the
  same API as `www.youtube.com/youtubei/` and stays reachable on networks
  that block youtube.com. "Load more" works through continuation tokens
  passed back and forth, so the server keeps no per-user state.
- **No stream handling on the server.** It never calls YouTube's `/player`
  endpoint and never touches video bytes, so playback costs your server no
  bandwidth and isn't affected by YouTube blocking datacenter IPs from
  streaming. The browser plays the video through the nocookie embed. The
  page controls the embed through YouTube's postMessage API (seeking,
  detecting when a video ends, detecting "embedding disabled" errors)
  without loading any script from youtube.com.
- **`server/index.js`**:
  - Express routes with an in-memory LRU cache (search 10 min, video
    30 min, …) and de-duplication of identical requests in flight.
  - gzip, per-IP rate limiting, a Content-Security-Policy and graceful
    shutdown.
- **`public/js/`**: plain ES modules with no build step, preloaded in
  parallel via `modulepreload`.

All text from YouTube (titles, descriptions, comments) is escaped; links are
added by the client, and no third-party HTML is injected.

## Run locally

Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm start          # or: npm run dev   (restarts on file changes)
```

Open **http://localhost:2222**. If your network needs a proxy to reach the
internet, set it first; Node's `fetch` doesn't use system proxy settings:

```powershell
$env:HTTPS_PROXY = "http://your-proxy-host:port"; npm start
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `2222` | Port (Render sets this itself) |
| `YOUTUBE_API_HOST` | `youtubei.googleapis.com` | InnerTube host; `www.youtube.com` also works where it isn't blocked |
| `RATE_LIMIT_API` | off locally, `180` hosted | API requests per minute per IP; `0` turns it off |
| `API_CACHE_ENTRIES` | `600` | In-memory response cache size |
| `HTTPS_PROXY` / `NO_PROXY` | none | Outbound proxy, for local corporate networks only |

"Hosted" means `NODE_ENV=production`, or running on Render (which sets
`RENDER=true`).

## Deploy to Render (free plan, Singapore)

`render.yaml` defines a free Node web service in the `singapore` region with
a `/health` check.

1. Push this folder to a GitHub or GitLab repository. Commit
   `package-lock.json`; `node_modules/` is already ignored.
2. In Render, choose **New + → Blueprint**, pick the repo and apply it. Each
   later push redeploys automatically.

To set the service up by hand (**New + → Web Service**), use:

- Region: Singapore
- Build command: `npm ci --omit=dev`
- Start command: `node --max-old-space-size=320 server/index.js`
- Health check path: `/health`
- Environment variables: `NODE_ENV=production`, `NODE_VERSION=22`

What to expect on the free plan:

- **Cold starts.** The service sleeps after 15 idle minutes. The next visit
  waits roughly 30–60 s while it wakes, and caches start empty.
- **Small footprint.** The server only moves JSON, about 3–20 KB gzipped
  per request. Video and thumbnails go straight from YouTube to the browser,
  so memory and bandwidth use stay low.
- **Possible bot checks.** YouTube occasionally challenges requests from
  datacenter IPs. Metadata endpoints are rarely affected. If requests start
  failing, the API returns a clear error, and switching
  `YOUTUBE_API_HOST` is the first thing to try.

## Known limitations

- **Embedding disabled.** Some videos, often music labels', can't be played
  in embeds. The player then shows an explanation and a "Watch on YouTube"
  link.
- **Playback runs in the browser.** The browser must be able to reach
  `www.youtube-nocookie.com` and YouTube's video servers. The server can't
  play videos on a network that blocks those.
- **No trending feed.** Signed-out YouTube has neither a home feed nor a
  trending page any more, so Home is built from your history (see above).
- **Library updates.** YouTube changes its internal API from time to time.
  If a page breaks, updating the `youtubei.js` dependency usually fixes it.
