// Client for the server's /api routes, with a short-lived in-memory cache so
// going back/forward between pages is instant and repeated renders of the
// same data don't refetch.

import { getSettings } from './store.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;
const cache = new Map();

export class ApiError extends Error {
  constructor(message, data = {}) {
    super(message);
    this.type = data.errorType || 'unknown';
  }
}

export function api(path, params = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') query.set(k, v);
  const url = `/api/${path}${query.size ? `?${query}` : ''}`;

  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.promise;

  const promise = fetch(url)
    .then(async res => {
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new ApiError(data?.error || `Request failed (HTTP ${res.status}).`, data || {});
      return data;
    })
    .catch(err => {
      cache.delete(url);
      throw err instanceof ApiError ? err : new ApiError('Network error — is the Findtube server running?');
    });

  cache.set(url, { promise, expires: Date.now() + CACHE_TTL_MS });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return promise;
}

// Video summaries seen in lists, so the watch page can show the title,
// channel and views immediately while the full details load.
const seenVideos = new Map();

export function rememberVideos(items) {
  for (const item of items) if (item.type === 'video') seenVideos.set(item.id, item);
  while (seenVideos.size > 1000) seenVideos.delete(seenVideos.keys().next().value);
}

export const peekVideo = id => seenVideos.get(id);

// Playback uses YouTube's privacy-enhanced embed, loaded by the visitor's
// browser. enablejsapi lets the page talk to the player (seek, detect the
// end of a video) through postMessage — see views/watch.js.
export const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

export function playerUrls(videoId, { start = 0 } = {}) {
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin: location.origin,
    rel: '0',
    playsinline: '1',
  });
  if (getSettings().autoplay) params.set('autoplay', '1');
  if (start > 0) params.set('start', String(start));
  return {
    embed: `${EMBED_ORIGIN}/embed/${encodeURIComponent(videoId)}?${params}`,
    watch: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}${start > 0 ? `&t=${start}` : ''}`,
  };
}
