// Image proxy.
//
// Thumbnails and avatars are served from /img on this server rather than
// hot-linked, for two reasons:
//  - Many instances now put their whole site (including /vi/ and /ggpht/
//    image routes) behind an anti-bot JavaScript check. A browser <img> tag
//    can't pass that check, so hot-linked images just break.
//  - Responses are cached here and marked immutable for the browser, so each
//    thumbnail is downloaded once, not on every page view.
//
// Each image URL carries an ordered list of sources: the instance first, then
// (unless DIRECT_IMAGE_FALLBACK=false) YouTube's own image CDN. A source host
// that answers with a non-image (e.g. an anti-bot page) is skipped for a while.

const { LruCache } = require('./cache');
const { fetchImage } = require('./http');

const { directImageFallback: DIRECT_FALLBACK, imageCacheMb } = require('../config');

const IMAGE_TIMEOUT_MS = 10000;
const BAD_HOST_COOLDOWN_MS = 10 * 60 * 1000;

const GOOGLE_IMAGE_HOSTS = new Set(['i.ytimg.com', 'i1.ytimg.com', 'i9.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com']);

const imageCache = new LruCache({ maxEntries: 4000, maxBytes: imageCacheMb * 1024 * 1024 });
const inflight = new Map();
const badHosts = new Map(); // host -> retry-after timestamp

function toAbsolute(url, instance) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return instance + url;
  return /^https?:\/\//i.test(url) ? url : '';
}

// Only proxy things that are recognisably video thumbnails or channel
// images, so /img can't be used as a general-purpose open proxy.
function isAllowedSource(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if (GOOGLE_IMAGE_HOSTS.has(parsed.hostname)) return DIRECT_FALLBACK;
  if (/^\/(vi|vi_webp|ggpht|sb)\//.test(parsed.pathname)) return true; // Invidious-style routes
  return GOOGLE_IMAGE_HOSTS.has(parsed.searchParams.get('host') || ''); // Piped proxy (?host=...)
}

function proxiedImage(...sources) {
  const list = sources.filter(Boolean).filter(isAllowedSource);
  const unique = [...new Set(list)];
  return unique.length ? '/img?' + unique.map(u => 'u=' + encodeURIComponent(u)).join('&') : '';
}

// --- Builders used by the backend parsers --------------------------------

function videoThumb(videoId, { instance, primary } = {}) {
  if (!videoId) return '';
  return proxiedImage(
    primary || (instance ? `${instance}/vi/${videoId}/hqdefault.jpg` : ''),
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  );
}

// Invidious returns yt3.ggpht.com / googleusercontent URLs; the instance
// mirrors them under /ggpht/.
function invidiousChannelImage(rawUrl, instance) {
  const url = toAbsolute(rawUrl, instance);
  if (!url) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (!GOOGLE_IMAGE_HOSTS.has(parsed.hostname)) return proxiedImage(url);
  return proxiedImage(`${instance}/ggpht${parsed.pathname}`, url);
}

// Piped returns its own proxy URLs with the original host in ?host=.
function pipedImage(rawUrl) {
  if (!rawUrl) return '';
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return '';
  }
  const originalHost = parsed.searchParams.get('host');
  let fallback = '';
  if (originalHost && GOOGLE_IMAGE_HOSTS.has(originalHost)) {
    const params = new URLSearchParams(parsed.search);
    params.delete('host');
    const qs = params.toString();
    fallback = `https://${originalHost}${parsed.pathname}${qs ? '?' + qs : ''}`;
  }
  return proxiedImage(rawUrl, fallback);
}

// --- /img route ------------------------------------------------------------

async function loadImage(url) {
  const cached = imageCache.get(url);
  if (cached) return cached;
  if (inflight.has(url)) return inflight.get(url);

  const promise = (async () => {
    const host = new URL(url).host;
    const result = await fetchImage(url, IMAGE_TIMEOUT_MS);
    if (result.ok) {
      const img = { type: result.type, body: result.body };
      imageCache.set(url, img, 24 * 60 * 60 * 1000, result.body.length);
      return img;
    }
    // A real 404 means "this image doesn't exist"; anything else (HTML
    // anti-bot page, 5xx, network error) means the host is unusable for now.
    if (result.status !== 404) badHosts.set(host, Date.now() + BAD_HOST_COOLDOWN_MS);
    return null;
  })().finally(() => inflight.delete(url));

  inflight.set(url, promise);
  return promise;
}

// Try sources in order, but "hedge": if one hasn't answered within
// HEDGE_MS, start the next in parallel and take whichever succeeds first.
// A slow instance then costs at most HEDGE_MS instead of a full timeout.
const HEDGE_MS = 1200;

function firstAvailable(urls) {
  return new Promise(resolve => {
    let next = 0;
    let pending = 0;
    let done = false;
    let timer;

    const startNext = () => {
      clearTimeout(timer);
      if (done) return;
      if (next >= urls.length) {
        if (!pending) {
          done = true;
          resolve(null);
        }
        return;
      }
      pending++;
      loadImage(urls[next++]).then(img => {
        pending--;
        if (done) return;
        if (img) {
          done = true;
          clearTimeout(timer);
          resolve(img);
        } else {
          startNext();
        }
      });
      timer = setTimeout(startNext, HEDGE_MS);
    };
    startNext();
  });
}

async function imageRoute(req, res) {
  const now = Date.now();
  const sources = []
    .concat(req.query.u || [])
    .slice(0, 4)
    .filter(url => typeof url === 'string' && isAllowedSource(url))
    .filter(url => (badHosts.get(new URL(url).host) || 0) <= now);

  const img = sources.length ? await firstAvailable(sources) : null;
  if (img) {
    res.set('Content-Type', img.type);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    return res.send(img.body);
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.status(404).end();
}

module.exports = { videoThumb, invidiousChannelImage, pipedImage, imageRoute, DIRECT_FALLBACK };
