// All environment-driven settings in one place. Defaults suit both a local
// run and Render's free plan (512 MB RAM, 0.1 CPU).

const env = process.env;
const int = (value, fallback) => (Number.isFinite(Number(value)) && value !== '' && value != null ? Number(value) : fallback);
const bool = (value, fallback) => (value == null || value === '' ? fallback : value === 'true' || value === '1');

// Render sets RENDER=true on its services.
const isHosted = bool(env.RENDER, false) || env.NODE_ENV === 'production';

module.exports = {
  isHosted,
  port: int(env.PORT, 2222),

  defaultInstance: {
    invidious: env.INVIDIOUS_INSTANCE || 'https://invidious.f5.si',
    piped: env.PIPED_INSTANCE || 'https://api.piped.private.coffee',
  },

  // Let the server fetch from private/internal addresses (e.g. a company's
  // self-hosted instance). Off on public deployments, where it would let any
  // visitor make the server probe its internal network.
  allowPrivateHosts: bool(env.ALLOW_PRIVATE_INSTANCES, !isHosted),

  // In-memory caches. Lost on restart, which is fine: they only save time.
  apiCacheEntries: int(env.API_CACHE_ENTRIES, 600),
  imageCacheMb: int(env.IMAGE_CACHE_MB, isHosted ? 40 : 64),

  // Per-IP requests per minute. 0 disables limiting.
  rateLimit: {
    api: int(env.RATE_LIMIT_API, isHosted ? 180 : 0),
    img: int(env.RATE_LIMIT_IMG, isHosted ? 900 : 0),
  },

  directImageFallback: bool(env.DIRECT_IMAGE_FALLBACK, true),
};
