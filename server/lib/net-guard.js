// Blocks outbound requests to private, loopback and link-local addresses.
//
// The server fetches whatever instance the visitor picks, plus image URLs.
// On a public deployment that would otherwise let anyone use it to reach
// internal services (cloud metadata endpoints, other containers, …).
// Disabled when ALLOW_PRIVATE_INSTANCES=true (the default for local runs,
// so a company-internal instance keeps working).

const dns = require('dns').promises;
const net = require('net');
const { allowPrivateHosts } = require('../config');

const LOOKUP_TTL_MS = 5 * 60 * 1000;
const lookups = new Map(); // hostname -> { ok, expires }

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]);
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

// Resolves to true if the URL's host is safe to fetch.
async function isPublicUrl(url) {
  if (allowPrivateHosts) return true;
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'localhost' || /\.(localhost|local|internal)$/.test(hostname)) return false;
  if (net.isIP(hostname)) return !isPrivateIp(hostname);

  const hit = lookups.get(hostname);
  if (hit && hit.expires > Date.now()) return hit.ok;

  let ok;
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    ok = addresses.length > 0 && addresses.every(a => !isPrivateIp(a.address));
  } catch {
    ok = true; // unresolvable: let the real request fail with a normal network error
  }
  lookups.set(hostname, { ok, expires: Date.now() + LOOKUP_TTL_MS });
  if (lookups.size > 1000) lookups.delete(lookups.keys().next().value);
  return ok;
}

module.exports = { isPublicUrl };
