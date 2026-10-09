// Outbound HTTP for talking to Invidious/Piped instances.
//
// node-fetch does NOT read HTTPS_PROXY/HTTP_PROXY on its own the way browsers
// or curl do — it always connects directly unless given an explicit agent. On
// networks that require a corporate proxy (the usual cause of ETIMEDOUT when a
// browser on the same machine works fine), this picks up the standard env vars
// and routes every outbound request through that proxy. NO_PROXY is honoured
// so a self-hosted instance on the local network can still be reached directly.

const http = require('http');
const https = require('https');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { isPublicUrl } = require('./net-guard');

const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].find(k => process.env[k]);
const PROXY_URL = PROXY_ENV ? process.env[PROXY_ENV] : null;
const NO_PROXY = (process.env.NO_PROXY || process.env.no_proxy || '')
  .split(',')
  .map(s => s.trim().toLowerCase().replace(/^\*?\./, ''))
  .filter(Boolean);

// Keep-alive agents: every page view fans out into several requests to the
// same instance, so reusing TLS connections saves a full handshake (often
// 100–300 ms through a proxy) on each of them.
const AGENT_OPTS = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 32 };
const httpAgent = new http.Agent(AGENT_OPTS);
const httpsAgent = new https.Agent(AGENT_OPTS);
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL, AGENT_OPTS) : null;

function bypassesProxy(hostname) {
  const host = hostname.toLowerCase();
  return NO_PROXY.some(rule => rule === '*' || host === rule || host.endsWith('.' + rule));
}

function agentFor(parsedUrl) {
  if (proxyAgent && !bypassesProxy(parsedUrl.hostname)) return proxyAgent;
  return parsedUrl.protocol === 'http:' ? httpAgent : httpsAgent;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class UpstreamError extends Error {
  constructor(message, { status = 502, type = 'upstream_error' } = {}) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function toNetworkError(err, host, timeoutMs) {
  if (err.name === 'AbortError') {
    return new UpstreamError(
      `${host} didn't answer within ${Math.round(timeoutMs / 1000)}s. It may be overloaded or rate-limited by YouTube right now — try again or pick another instance.`,
      { status: 504, type: 'timeout' }
    );
  }
  const connectFailure = /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET/.test(err.message || '');
  const hint =
    connectFailure && !PROXY_URL
      ? ' If your browser can reach it but this server can\'t, your network probably needs a proxy — set HTTPS_PROXY and restart.'
      : '';
  return new UpstreamError(`Couldn't reach ${host}: ${err.message}.${hint}`, { status: 502, type: 'network_error' });
}

const MAX_REDIRECTS = 3;

// Fetch with a hard deadline that covers the body read too, not just headers.
// Redirects are followed by hand so every hop passes the private-address
// check, and bodies are size-capped so one huge response can't exhaust the
// free plan's memory.
async function rawFetch(url, { timeoutMs, headers, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (!(await isPublicUrl(current))) {
        throw new UpstreamError(`${new URL(current).host} is a private or internal address, which this server won't contact.`, {
          status: 400,
          type: 'blocked_host',
        });
      }
      const res = await fetch(current, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
        agent: agentFor,
        signal: controller.signal,
        redirect: 'manual',
        size: maxBytes,
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
        current = new URL(location, current).href;
        continue;
      }
      const body = await res.buffer();
      return { res, body };
    }
  } finally {
    clearTimeout(timer);
  }
}

function describeHtml(text, host) {
  if (/not a bot|anubis|verifying your browser|captcha|challenge|cloudflare/i.test(text)) {
    return new UpstreamError(
      `${host} put this request behind an anti-bot browser check, so its API can't be used from this app. Pick another instance.`,
      { type: 'bot_check' }
    );
  }
  return new UpstreamError(
    `${host} returned a web page instead of API data — its API is probably disabled. Pick another instance.`,
    { type: 'not_api' }
  );
}

async function fetchJson(url, timeoutMs) {
  const host = new URL(url).host;
  let res, body;
  try {
    ({ res, body } = await rawFetch(url, { timeoutMs, headers: { Accept: 'application/json' }, maxBytes: 8 * 1024 * 1024 }));
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw toNetworkError(err, host, timeoutMs);
  }

  const text = body.toString('utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (text.trimStart().startsWith('<')) throw describeHtml(text, host);
    throw new UpstreamError(`${host} responded with status ${res.status} and an unreadable body.`, { type: 'bad_response' });
  }

  if (!res.ok) {
    // Instances usually explain themselves in an {"error": "..."} body; the
    // first line is enough (Piped includes full Java stack traces).
    const detail = typeof data?.error === 'string' ? data.error.split('\n')[0].slice(0, 240) : '';
    throw new UpstreamError(`${host} responded with status ${res.status}${detail ? `: ${detail}` : ''}`, {
      status: res.status === 404 ? 404 : 502,
      type: 'bad_status',
    });
  }
  return data;
}

// For images: returns null instead of throwing, so the caller can try the next source.
async function fetchImage(url, timeoutMs) {
  try {
    const { res, body } = await rawFetch(url, { timeoutMs, headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }, maxBytes: 4 * 1024 * 1024 });
    const type = res.headers.get('content-type') || '';
    return { ok: res.ok && type.startsWith('image/'), status: res.status, type, body };
  } catch (err) {
    return { ok: false, status: 0, error: err };
  }
}

module.exports = { PROXY_URL, PROXY_ENV, UpstreamError, fetchJson, fetchImage };
