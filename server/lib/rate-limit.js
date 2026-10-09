// Fixed-window per-IP rate limiter, kept in memory. Enough to stop one
// client from burning the free plan's CPU/bandwidth or getting the shared
// upstream instances to block this server.

function rateLimit({ perMinute, name }) {
  if (!perMinute) return (req, res, next) => next();
  const windows = new Map(); // ip -> { count, resetAt }

  setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of windows) if (w.resetAt <= now) windows.delete(ip);
  }, 60 * 1000).unref();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || 'unknown';
    let w = windows.get(ip);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + 60 * 1000 };
      windows.set(ip, w);
    }
    if (++w.count <= perMinute) return next();

    res.set('Retry-After', String(Math.ceil((w.resetAt - now) / 1000)));
    if (name === 'api') {
      return res.status(429).json({ error: 'Too many requests — please slow down for a moment.', errorType: 'rate_limited' });
    }
    res.status(429).end();
  };
}

module.exports = { rateLimit };
