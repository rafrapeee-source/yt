// Helpers for turning upstream values into the plain, predictable shapes the
// frontend expects. Upstream HTML is always flattened to plain text here; the
// frontend escapes everything and adds its own links, so no third-party
// markup is ever injected into the page.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(str) {
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

// YouTube wraps external links as youtube.com/redirect?q=<real url>.
function unwrapRedirect(href) {
  try {
    const url = new URL(href);
    if (/youtube\.com$/.test(url.hostname) && url.pathname === '/redirect') return url.searchParams.get('q') || href;
  } catch {
    /* not a URL */
  }
  return href;
}

function htmlToText(html) {
  if (!html) return '';
  const withLinks = html.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const label = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
    // Link labels for long URLs are truncated ("https://example.com/abc..."),
    // so prefer the real href. Timestamps and hashtags keep their label.
    if (/^https?:\/\//i.test(label) || label.endsWith('...') || label.endsWith('…')) {
      return unwrapRedirect(decodeEntities(href));
    }
    return label;
  });
  return decodeEntities(
    withLinks
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
  ).trim();
}

function toNumber(value) {
  const n = typeof value === 'string' ? Number(value.replace(/[^\d.]/g, '')) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

// "/channel/UCxxxx" or "https://www.youtube.com/channel/UCxxxx" -> "UCxxxx"
function channelIdFromUrl(url) {
  const match = /\/channel\/([\w-]+)/.exec(url || '');
  return match ? match[1] : '';
}

function videoIdFromUrl(url) {
  const match = /[?&]v=([\w-]{11})/.exec(url || '');
  return match ? match[1] : '';
}

module.exports = { decodeEntities, htmlToText, toNumber, channelIdFromUrl, videoIdFromUrl };
