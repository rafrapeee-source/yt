// All environment-driven settings in one place. Defaults suit both a local
// run and Render's free plan (512 MB RAM, 0.1 CPU).

const env = process.env;
const int = (value, fallback) => (value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);

// Render sets RENDER=true on its services.
const isHosted = env.RENDER === 'true' || env.NODE_ENV === 'production';

module.exports = {
  isHosted,
  port: int(env.PORT, 2222),

  // Host serving YouTube's internal API. youtubei.googleapis.com is the same
  // API as www.youtube.com/youtubei/ and also works where youtube.com is blocked.
  youtubeApiHost: env.YOUTUBE_API_HOST || 'youtubei.googleapis.com',

  // In-memory API response cache (lost on restart; it only saves time).
  apiCacheEntries: int(env.API_CACHE_ENTRIES, 600),

  // Per-IP requests per minute to /api. 0 disables limiting.
  rateLimitApi: int(env.RATE_LIMIT_API, isHosted ? 180 : 0),
};
