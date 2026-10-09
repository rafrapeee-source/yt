// Findtube server: serves the single-page app and a small JSON API backed
// directly by YouTube (see youtube.js). No third-party instances involved.
//
// Routes:
//   GET /api/search?q&type&sort&date&duration&continuation
//   GET /api/suggestions?q
//   GET /api/home?seeds=<videoId,videoId,...>
//   GET /api/video/:id
//   GET /api/related?continuation
//   GET /api/comments/:id?sort&continuation
//   GET /api/channel/:id
//   GET /api/channel/:id/videos?continuation
//   GET /health

const path = require('path');
const express = require('express');
const compression = require('compression');

const config = require('./config');
const { rateLimit } = require('./lib/rate-limit');
const { LruCache, memoize } = require('./lib/cache');
const yt = require('./youtube');

// Outbound proxy (only needed on networks like a corporate LAN; not on Render).
// Node's built-in fetch ignores HTTPS_PROXY unless a proxy dispatcher is set.
if (['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(k => process.env[k])) {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MINUTE = 60 * 1000;
const TTL = {
  search: 10 * MINUTE,
  suggestions: 60 * MINUTE,
  home: 15 * MINUTE,
  video: 30 * MINUTE,
  related: 30 * MINUTE,
  comments: 10 * MINUTE,
  channel: 15 * MINUTE,
};

const cached = memoize(new LruCache({ maxEntries: config.apiCacheEntries }));
const getVideo = id => cached(`video|${id}`, TTL.video, () => yt.video(id));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // req.ip from X-Forwarded-For behind Render's proxy (rate limiting)
app.use(compression()); // gzip JSON/HTML/JS/CSS

// The page loads thumbnails from YouTube's image hosts and the player from
// youtube-nocookie.com; everything else comes from this server.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://i.ytimg.com https://*.ytimg.com https://yt3.ggpht.com https://yt3.googleusercontent.com",
  'frame-src https://www.youtube-nocookie.com',
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});

// --- Helpers -------------------------------------------------------------------

const VIDEO_ID = /^[\w-]{11}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;

function badRequest(message) {
  return new yt.YouTubeError(message, 400, 'bad_request');
}

function requireMatch(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw badRequest(`Invalid ${label}.`);
  return value;
}

const str = (value, max = 2000) => (typeof value === 'string' ? value.slice(0, max) : '');

// Runs a handler and turns failures into JSON errors the UI can show.
function route(handler) {
  return async (req, res) => {
    const startedAt = Date.now();
    try {
      const data = await handler(req);
      res.set('Cache-Control', 'private, max-age=60');
      res.json({ ...data, elapsedMs: Date.now() - startedAt });
    } catch (err) {
      const known = err instanceof yt.YouTubeError;
      if (!known) console.error(`[${req.path}]`, err);
      res.status(known ? err.status : 500).json({ error: known ? err.message : 'Unexpected server error.', errorType: known ? err.type : 'internal' });
    }
  };
}

// --- API -------------------------------------------------------------------------

app.use('/api', rateLimit({ perMinute: config.rateLimitApi, name: 'api' }));

app.get(
  '/api/search',
  route(req => {
    const q = str(req.query.q, 200).trim();
    if (!q) throw badRequest('Missing search query.');
    const opts = {
      q,
      type: str(req.query.type, 20),
      sort: str(req.query.sort, 20),
      date: str(req.query.date, 20),
      duration: str(req.query.duration, 20),
      continuation: str(req.query.continuation, 8000),
    };
    return cached(`search|${JSON.stringify(opts)}`, TTL.search, () => yt.search(opts));
  })
);

app.get(
  '/api/suggestions',
  route(async req => {
    const q = str(req.query.q, 100).trim().toLowerCase();
    return { suggestions: q ? await cached(`sugg|${q}`, TTL.suggestions, () => yt.suggestions(q)) : [] };
  })
);

// Signed-out YouTube has no home feed or trending page any more, so Home is
// built like YouTube's own recommendations: videos related to what this
// visitor watched recently (sent from their local history), falling back to
// this week's most-viewed videos for first-time visitors.
app.get(
  '/api/home',
  route(async req => {
    const seeds = str(req.query.seeds, 200).split(',').filter(id => VIDEO_ID.test(id)).slice(0, 3);
    if (seeds.length) {
      const pages = await Promise.allSettled(seeds.map(getVideo));
      const lists = pages.filter(p => p.status === 'fulfilled').map(p => p.value.related);
      const items = [];
      const seen = new Set(seeds);
      for (let i = 0; lists.some(l => i < l.length); i++) {
        for (const list of lists) {
          const v = list[i];
          if (v && !seen.has(v.id)) {
            seen.add(v.id);
            items.push(v);
          }
        }
      }
      if (items.length) return { items, continuation: null, source: 'history' };
    }
    const page = await cached('home|popular', TTL.home, () => yt.search({ q: 'trending', type: 'videos', sort: 'view_count', date: 'week' }));
    return { ...page, source: 'popular' };
  })
);

app.get(
  '/api/video/:id',
  route(async req => {
    const { commentsToken, ...video } = await getVideo(requireMatch(req.params.id, VIDEO_ID, 'video id'));
    return video;
  })
);

app.get(
  '/api/related',
  route(req => {
    const continuation = str(req.query.continuation, 8000);
    if (!continuation) throw badRequest('Missing continuation.');
    return cached(`related|${continuation}`, TTL.related, () => yt.relatedPage(continuation));
  })
);

app.get(
  '/api/comments/:id',
  route(async req => {
    const id = requireMatch(req.params.id, VIDEO_ID, 'video id');
    const sort = req.query.sort === 'new' ? 'new' : 'top';
    const continuation = str(req.query.continuation, 8000);
    return cached(`comments|${id}|${sort}|${continuation}`, TTL.comments, async () => {
      const videoToken = continuation ? null : (await getVideo(id)).commentsToken;
      const { sortTokens, ...page } = await yt.comments(id, { sort, continuation, videoToken });
      return page;
    });
  })
);

app.get(
  '/api/channel/:id',
  route(req => {
    const id = requireMatch(req.params.id, CHANNEL_ID, 'channel id');
    return cached(`channel|${id}`, TTL.channel, () => yt.channel(id));
  })
);

app.get(
  '/api/channel/:id/videos',
  route(req => {
    const id = requireMatch(req.params.id, CHANNEL_ID, 'channel id');
    const continuation = str(req.query.continuation, 8000);
    const channel = { name: str(req.query.name, 200), avatar: str(req.query.avatar, 2000) };
    return cached(`channelVideos|${id}|${continuation}`, TTL.channel, () => yt.channelVideos(id, { continuation, channel }));
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.', errorType: 'not_found' }));

// Used by Render's health check (see render.yaml).
app.get('/health', (req, res) => res.json({ ok: true }));

// --- Frontend ----------------------------------------------------------------------

// No build step means no hashed filenames, so assets are revalidated on every
// load (a cheap 304 via ETag) instead of risking stale code after a deploy.
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: 0, setHeaders: res => res.set('Cache-Control', 'no-cache') }));

// Single-page app: any other GET (/watch?v=…, /channel/UC…) gets index.html.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- Start / stop --------------------------------------------------------------------

const server = app.listen(config.port, () => {
  console.log(`Findtube listening on port ${config.port}${config.isHosted ? ' (hosted mode)' : ` — http://localhost:${config.port}`}`);
  console.log(`YouTube API host: ${config.youtubeApiHost}; rate limit: ${config.rateLimitApi || 'off'} req/min/IP`);
  yt.warmUp();
});

// Outlive the platform load balancer's idle timeout to avoid sporadic 502s.
server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 125 * 1000;

// Render sends SIGTERM before replacing the instance: finish requests, then exit.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10 * 1000).unref();
  });
}
