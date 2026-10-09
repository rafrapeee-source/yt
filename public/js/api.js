// Client for the server's /api routes, with a short-lived in-memory cache so
// going back/forward between pages is instant and repeated renders of the
// same data don't refetch.

import { getSettings, currentInstance } from './store.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;
const cache = new Map();

export class ApiError extends Error {
  constructor(message, data = {}) {
    super(message);
    this.type = data.errorType || 'unknown';
    this.instance = data.instance;
  }
}

export function api(path, params = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') query.set(k, v);
  query.set('backend', getSettings().backend);
  query.set('instance', currentInstance());
  const url = `/api/${path}?${query}`;

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

// Where the embedded player is loaded from. Invidious serves /embed/ itself;
// Piped's player lives on its web frontend, whose host usually drops the
// "api" part of the API host (pipedapi.kavin.rocks -> piped.kavin.rocks).
export function playerUrls(videoId, { start = 0 } = {}) {
  const s = getSettings();
  const instance = currentInstance();
  const override = s.playerHost[s.backend]?.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const host =
    override ||
    (s.backend === 'piped'
      ? instance.replace(/^pipedapi\./, 'piped.').replace(/^piped-api\./, 'piped.').replace(/^api\./, '')
      : instance);

  const params = new URLSearchParams();
  if (s.autoplay) params.set('autoplay', '1');
  if (start > 0) params.set('t', String(start));
  if (s.backend === 'invidious' && s.proxyVideo) params.set('local', 'true');

  return {
    host,
    embed: `https://${host}/embed/${encodeURIComponent(videoId)}?${params}`,
    watch: `https://${host}/watch?v=${encodeURIComponent(videoId)}${start > 0 ? `&t=${start}` : ''}`,
  };
}
