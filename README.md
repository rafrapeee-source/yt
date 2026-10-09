# Findtube

A YouTube-style web app that runs entirely through
[Invidious](https://invidious.io) or [Piped](https://docs.piped.video)
instances (open-source, privacy-respecting YouTube front ends). It works on
networks where youtube.com is blocked but an instance is reachable. Check
your IT policy before relying on that.

## Features

- **Home**: trending videos and topic chips (Music, Gaming, News, …).
- **Search**: suggestions as you type, All/Videos/Channels tabs, infinite
  scroll. On Invidious you can also filter by sort order, upload date and
  duration.
- **Watch page**:
  - Player, title, channel (with avatar, subscriber count and a Subscribe
    button), likes, a Share button and an expandable description.
  - Links, `1:23` timestamps (click to seek) and #hashtags in the
    description are clickable.
  - Related videos in a side column.
  - Comments (top or newest) with pinned and creator-hearted badges,
    threaded replies and "Read more".
- **Channel pages**: banner, avatar, subscriber count, a Videos tab with
  infinite scroll, and an About tab.
- **Subscriptions** (stored in your browser): the channels appear in the
  sidebar, and a feed merges their latest uploads.
- **Watch history** (stored in your browser).
- Back and Forward restore pages instantly at the same scroll position.
- Layout adapts to desktop, tablet and phone, with light and dark themes
  that follow your OS. Press `/` to focus the search box.

## Run

Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm start          # or: npm run dev   (restarts on file changes)
```

Open **http://localhost:2222**.

All settings are environment variables, collected in `server/config.js`.
"Hosted" means `NODE_ENV=production`, or running on Render (which sets
`RENDER=true`).

| Variable | Default (local / hosted) | Purpose |
| --- | --- | --- |
| `PORT` | `2222` | Port to listen on (Render sets this itself) |
| `INVIDIOUS_INSTANCE`, `PIPED_INSTANCE` | invidious.f5.si, api.piped.private.coffee | Default instance for each backend |
| `HTTPS_PROXY` / `HTTP_PROXY` | none | Outbound proxy (see below). `NO_PROXY` is honoured |
| `ALLOW_PRIVATE_INSTANCES` | `true` / `false` | Allow fetching from private/internal addresses (e.g. a company-internal instance) |
| `RATE_LIMIT_API`, `RATE_LIMIT_IMG` | off / `180`, `900` | Requests per minute per IP; `0` turns it off |
| `IMAGE_CACHE_MB` | `64` / `40` | In-memory thumbnail cache size |
| `API_CACHE_ENTRIES` | `600` | In-memory API response cache size |
| `DIRECT_IMAGE_FALLBACK` | `true` | `false` = never fetch thumbnails from YouTube's image CDN |

## Deploy to Render (free plan, Singapore)

The repo includes a [Blueprint](https://render.com/docs/blueprint-spec)
(`render.yaml`): a free Node web service in the `singapore` region,
with a `/health` check.

1. Push this folder to a GitHub or GitLab repository. Commit
   `package-lock.json`; `node_modules/` is already ignored.
2. In the Render dashboard, choose **New + → Blueprint**, pick the repo and
   apply it. Each later push redeploys automatically.
3. Open `https://<service-name>.onrender.com`.

To set the service up by hand instead (**New + → Web Service**), use:

- Region: Singapore
- Build command: `npm ci --omit=dev`
- Start command: `node --max-old-space-size=320 server/index.js`
- Health check path: `/health`
- Environment variables: `NODE_ENV=production` and `NODE_VERSION=22`

What to expect on the free plan:

- **Cold starts.** The service sleeps after 15 minutes without traffic, and
  the next visit waits roughly 30–60 s while it wakes. The caches are
  in-memory, so they start empty after each wake-up or deploy.
- **Memory.** About 80 MB in use, plus up to 40 MB of thumbnail cache. That
  is well under the 512 MB limit.
- **Bandwidth.** Thumbnails go through the server, and the free plan
  includes a monthly bandwidth allowance. Browsers cache each image for a
  week, and JSON and assets are gzipped, which keeps usage low.
- **Instances may treat Render differently from your PC.** Some public
  instances block or challenge datacenter IP addresses. If the defaults fail
  on Render but work locally, set `INVIDIOUS_INSTANCE` / `PIPED_INSTANCE` to
  an instance that works from there.
- **Corporate proxy.** Don't set `HTTPS_PROXY` on Render; it isn't needed
  there.

### What changes on a public deployment

Running publicly means anyone can call the server, so hosted mode turns on
the following protections:

- **No CORS headers**, so other websites can't use the API as a free proxy.
- **Private-address blocking.** The server refuses to contact private,
  loopback or link-local addresses: instances, images, and every redirect
  hop. Visitors can't use the instance picker to probe Render's internal
  network.
- **Per-IP rate limits** on `/api` and `/img`.
- **Response size caps.** Upstream responses are limited to 8 MB of JSON and
  4 MB per image.
- **Security headers**, including a Content-Security-Policy. Scripts may
  only come from this server; the player iframe and video may come from any
  instance.

For every deployment:

- gzip compression is on.
- The keep-alive timeout is longer than the load balancer's, which avoids
  sporadic 502 errors.
- The server shuts down gracefully on `SIGTERM` during redeploys.
- `/health` doesn't reveal the proxy URL, and credentials in the proxy URL
  are masked in the logs.

## Choosing an instance

Click the instance pill (top right), or the gear icon, to pick the backend
(Invidious or Piped) and an instance, or to add any other instance address.
A company-run or self-hosted instance is the most reliable choice. The
colored dot shows whether the current instance is up.

Public instances change constantly. YouTube rate-limits and blocks them, and
many now put their web pages behind anti-bot checks. When something fails,
the error panel offers **Retry** and **Try *next instance***. Live status
lists: [Invidious](https://api.invidious.io) and
[Piped](https://piped-instances.kavin.rocks).

## Playback

There are two players, and you can switch between them under the video or
in Settings:

- **Built-in player** (default when available): a plain HTML5 `<video>`
  that plays the stream URLs the instance provides, usually 360p. It works
  even when the instance's web pages are behind an anti-bot check. It also
  seeks precisely on timestamp clicks and can autoplay the next related
  video. If the stream fails to load, the app automatically switches to the
  instance's player.
- **Instance player**: the instance's own embedded player. It can play HD,
  but it breaks if the instance's site is blocked or challenge-protected.
  For Piped, the player domain is guessed (`pipedapi.x` → `piped.x`). Set
  **Player host** in Settings if the guess is wrong.

For Invidious, the "Stream video through the instance" setting adds
`local=true`, so video bytes come from the instance rather than from Google.

## How it works

```
browser ──► Findtube server (Express) ──► Invidious / Piped instance ──► YouTube
             ├─ /api/*   normalized JSON (same shape for both backends)
             ├─ /img     cached thumbnail/avatar proxy
             └─ /*       single-page app (public/)
```

- **`server/backends/`**: one adapter per backend. Each converts the
  instance's API responses into a single format: videos, channels, comments,
  and pages with a `continuation` token for loading more.
- **`server/lib/cache.js`**: an in-memory LRU cache with per-route TTLs
  (search 10 min, video 30 min, …), plus de-duplication of identical
  requests that are in flight at the same time.
- **`server/lib/http.js`**: keep-alive connections (a TLS handshake through
  a proxy costs 100–300 ms per request otherwise), timeouts that cover the
  whole response, and clear errors. For example, it detects an anti-bot page
  served where JSON was expected and says so, instead of failing on bad JSON.
- **`server/lib/images.js`**: thumbnails go through `/img`. Each image is
  requested from the instance first and from YouTube's image CDN as a
  fallback. A slow source is "hedged": after 1.2 s the next source starts in
  parallel. Hosts that answer with non-images are skipped for 10 minutes.
  Results are cached in memory (64 MB) and marked immutable for the browser.
  Only thumbnail and avatar paths are allowed, so `/img` can't be used as an
  open proxy.
- **`server/config.js`**: every environment setting and its default.
  **`server/lib/net-guard.js`** and **`rate-limit.js`** contain the
  public-deployment protections.
- **`public/js/`**: plain ES modules with no build step. `index.html`
  preloads the whole module graph with `modulepreload`, so the browser
  fetches it in parallel rather than one import level (one round trip) at a
  time. They include a
  small History-API router (`main.js`), the API client with a 5-minute
  response cache (`api.js`), local storage for settings, subscriptions and
  history (`store.js`), shared UI builders (`components.js`), and one module
  per page in `views/`.

All text from upstream (titles, descriptions, comments) is escaped. Piped's
HTML descriptions are flattened to plain text on the server, and the client
adds its own links. No third-party markup is ever injected into the page.

## Using a corporate proxy

Node does **not** pick up your OS or browser proxy settings automatically.
If your browser can reach an instance but this app fails with errors like
`connect ETIMEDOUT`, set the proxy before starting the server:

```powershell
# Windows PowerShell
$env:HTTPS_PROXY = "http://your-proxy-host:port"
npm start
```

```bash
# macOS / Linux
HTTPS_PROXY="http://your-proxy-host:port" npm start
```

On startup, the server logs which proxy it's using. If the proxy needs
credentials, use `http://user:password@host:port`. To find the address,
check your browser's proxy settings (Chrome:
`chrome://net-internals/#proxy`) or your IT documentation.

## Privacy notes

- The instance operator can see your searches and IP address, as any
  website can. Pick an instance you trust.
- Image fallback contacts `i.ytimg.com` / `yt3.ggpht.com` from the server
  (not from your browser) when the instance can't serve an image. Disable it
  with `DIRECT_IMAGE_FALLBACK=false`.
- Subscriptions, history and settings are stored only in your browser's
  localStorage.

## Known limitations

- Everything depends on third-party instances being up and not blocked by
  YouTube. Errors like "Sign in to confirm you're not a bot" come from
  YouTube blocking that instance. Try another one.
- Some Piped instances can't currently list a channel's uploads. The channel
  page then falls back to search results from that channel. Invidious
  handles channel pages and the subscriptions feed more reliably.
- The built-in player only gets combined audio+video streams, which YouTube
  now offers only up to 360p. Use the instance player for HD.
