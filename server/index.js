// Findtube server: serves the single-page app and a small JSON API that
// normalizes Invidious and Piped responses into one shape.
//
// Normalized shapes (see backends/*.js):
//   Video   { type:'video', id, title, thumbnail, duration, isLive, views, viewsText,
//             published, publishedText, description, channel:{ id, name, avatar, verified } }
//   Channel { type:'channel', id, name, avatar, verified, subscribers, videoCount, description }
//   Page    { items: [...], continuation }   — pass `continuation` back to get the next page.
//
// Every /api route takes `backend` (invidious|piped) and `instance` query params.

const path = require('path');
const express = require('express');
const compression = require('compression');

const config = require('./config');
const { rateLimit } = require('./lib/rate-limit');

const { PROXY_URL, PROXY_ENV, UpstreamError } = require('./lib/http');
const { LruCache, memoize } = require('./lib/cache');
const { imageRoute, DIRECT_FALLBACK } = require('./lib/images');
const { FAST_TIMEOUT_MS, SLOW_TIMEOUT_MS } = require('./backends/timeouts');

const BACKENDS = {
  invidious: require('./backends/invidious'),
  piped: require('./backends/piped'),
};

const DEFAULT_INSTANCE = config.defaultInstance;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MINUTE = 60 * 1000;
const TTL = {
  check: 1 * MINUTE,
  trending: 15 * MINUTE,
  search: 10 * MINUTE,
  suggestions: 60 * MINUTE,
  video: 30 * MINUTE,
  comments: 10 * MINUTE,
  channel: 15 * MINUTE,
};

const cached = memoize(new LruCache({ maxEntries: config.apiCacheEntries }));

const app = express();
app.disable('x-powered-by');
// Behind Render's proxy, req.ip comes from X-Forwarded-For (used for rate limiting).
app.set('trust proxy', true);

// gzip JSON, HTML, JS and CSS (roughly 4-5x smaller); images are skipped
// automatically since they are already compressed.
app.use(compression());

// The page only talks to this server and loads the player from whichever
// instance is selected. No CORS headers: other sites can't use this API.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' https: http: blob:",
  "frame-src https: http:",
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

// --- Request helpers -------------------------------------------------------

function normalizeBackend(raw) {
  return raw === 'piped' ? 'piped' : 'invidious';
}

function normalizeInstance(raw, backend) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return DEFAULT_INSTANCE[backend];
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new UpstreamError(`"${raw}" isn't a valid instance address.`, { status: 400, type: 'bad_request' });
  }
}

const VIDEO_ID = /^[\w-]{11}$/;
const CHANNEL_ID = /^[\w-]{2,64}$/;

function requireMatch(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new UpstreamError(`Invalid ${label}.`, { status: 400, type: 'bad_request' });
  }
  return value;
}

function str(value, max = 2000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// Wraps an API route: resolves backend + instance, runs the handler through
// the shared cache, and turns failures into JSON errors the UI can show.
function apiRoute(name, handler) {
  return async (req, res) => {
    let backend, instance;
    try {
      backend = normalizeBackend(req.query.backend);
      instance = normalizeInstance(req.query.instance, backend);
      const ctx = { req, backend, instance, impl: BACKENDS[backend] };
      const { key, run } = handler(ctx);
      const startedAt = Date.now();
      const data = await cached(`${backend}|${instance}|${name}|${key}`, TTL[name], run);
      res.set('Cache-Control', 'private, max-age=60');
      res.json({ ...data, backend, instance, elapsedMs: Date.now() - startedAt });
    } catch (err) {
      const isKnown = err instanceof UpstreamError;
      if (!isKnown) console.error(`[${name}]`, err);
      res.status(isKnown ? err.status : 500).json({
        error: isKnown ? err.message : `Unexpected error: ${err.message}`,
        errorType: isKnown ? err.type : 'internal',
        backend,
        instance,
      });
    }
  };
}

// --- API -------------------------------------------------------------------

app.use('/api', rateLimit({ perMinute: config.rateLimit.api, name: 'api' }));

app.get(
  '/api/check-instance',
  apiRoute('check', ({ impl, instance }) => ({
    key: '',
    run: () => impl.check(instance),
  }))
);

app.get(
  '/api/trending',
  apiRoute('trending', ({ req, impl, instance }) => {
    const region = /^[A-Z]{2}$/.test(req.query.region) ? req.query.region : 'US';
    return { key: region, run: () => impl.trending(instance, { region }) };
  })
);

app.get(
  '/api/search',
  apiRoute('search', ({ req, impl, instance }) => {
    const q = str(req.query.q, 200).trim();
    if (!q) throw new UpstreamError('Missing search query.', { status: 400, type: 'bad_request' });
    const opts = {
      q,
      type: str(req.query.type, 20),
      sort: str(req.query.sort, 20),
      date: str(req.query.date, 20),
      duration: str(req.query.duration, 20),
      continuation: str(req.query.continuation, 8000),
    };
    return { key: JSON.stringify(opts), run: () => impl.search(instance, opts) };
  })
);

app.get(
  '/api/suggestions',
  apiRoute('suggestions', ({ req, impl, instance }) => {
    const q = str(req.query.q, 100).trim().toLowerCase();
    return { key: q, run: async () => ({ suggestions: q ? await impl.suggestions(instance, q) : [] }) };
  })
);

app.get(
  '/api/video/:id',
  apiRoute('video', ({ req, impl, instance }) => {
    const id = requireMatch(req.params.id, VIDEO_ID, 'video id');
    return { key: id, run: () => impl.video(instance, id) };
  })
);

app.get(
  '/api/comments/:id',
  apiRoute('comments', ({ req, impl, instance }) => {
    const id = requireMatch(req.params.id, VIDEO_ID, 'video id');
    const opts = { sort: str(req.query.sort, 10), continuation: str(req.query.continuation, 8000) };
    return { key: `${id}|${opts.sort}|${opts.continuation}`, run: () => impl.comments(instance, id, opts) };
  })
);

app.get(
  '/api/channel/:id',
  apiRoute('channel', ({ req, impl, instance }) => {
    const id = requireMatch(req.params.id, CHANNEL_ID, 'channel id');
    return { key: id, run: () => impl.channel(instance, id) };
  })
);

app.get(
  '/api/channel/:id/videos',
  apiRoute('channel', ({ req, impl, instance }) => {
    const id = requireMatch(req.params.id, CHANNEL_ID, 'channel id');
    const continuation = str(req.query.continuation, 8000);
    const channel = { name: str(req.query.name, 200), avatar: str(req.query.avatar, 2000) };
    return {
      key: `videos|${id}|${continuation}`,
      run: () => impl.channelVideos(instance, id, { continuation, channel }),
    };
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.', errorType: 'not_found' }));

app.get('/img', rateLimit({ perMinute: config.rateLimit.img, name: 'img' }), imageRoute);

// Used by Render's health check (see render.yaml).
app.get('/health', (req, res) => res.json({ ok: true }));

// --- Frontend ----------------------------------------------------------------

// No build step means no hashed filenames, so assets are revalidated on every
// load (a cheap 304 via ETag). A long max-age would let browsers mix old and
// new modules for a while after each deploy.
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: 0, setHeaders: res => res.set('Cache-Control', 'no-cache') }));

// Single-page app: any other GET (e.g. /watch?v=..., /channel/UC...) gets
// index.html and the client-side router takes it from there.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- Start / stop --------------------------------------------------------------

const maskCredentials = url => url.replace(/\/\/[^@/]+@/, '//***@');

const server = app.listen(config.port, () => {
  console.log(`Findtube listening on port ${config.port}${config.isHosted ? ' (hosted mode)' : ` — http://localhost:${config.port}`}`);
  console.log(`Default instances: ${DEFAULT_INSTANCE.invidious} (Invidious), ${DEFAULT_INSTANCE.piped} (Piped)`);
  console.log(`Timeouts — fast: ${FAST_TIMEOUT_MS}ms, slow: ${SLOW_TIMEOUT_MS}ms`);
  console.log(
    `Image cache: ${config.imageCacheMb} MB, YouTube CDN fallback ${DIRECT_FALLBACK ? 'on' : 'off'}; ` +
      `private instance addresses ${config.allowPrivateHosts ? 'allowed' : 'blocked'}; ` +
      `rate limits (req/min/IP): api ${config.rateLimit.api || 'off'}, img ${config.rateLimit.img || 'off'}`
  );
  console.log(PROXY_URL ? `Outbound proxy: ${maskCredentials(PROXY_URL)} (from ${PROXY_ENV})` : 'Outbound proxy: none');
});

// Keep idle connections open longer than the platform's load balancer does,
// so it never reuses a socket Node has just closed (which shows up as 502s).
server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 125 * 1000;

// Render sends SIGTERM before replacing or stopping the instance; finish
// in-flight requests, then exit.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10 * 1000).unref();
  });
}
