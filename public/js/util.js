// Formatting and DOM helpers shared by every view.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c]);
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function html(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.childElementCount === 1 ? tpl.content.firstElementChild : tpl.content;
}

const compactFormatter = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const fullFormatter = new Intl.NumberFormat('en');

export const compact = n => compactFormatter.format(n);
export const fullNumber = n => fullFormatter.format(n);

export function plural(n, word) {
  return `${compact(n)} ${word}${n === 1 ? '' : 's'}`;
}

export function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

export function timeAgo(ms) {
  if (!ms) return '';
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  for (const [unit, size] of UNITS) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

export function formatDate(ms) {
  return ms ? new Date(ms).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

export function viewsLabel(video) {
  if (video.isLive) return video.views ? `${compact(video.views)} watching` : 'Live';
  if (video.views != null) return plural(video.views, 'view');
  if (video.viewsText) return /view/i.test(video.viewsText) ? video.viewsText : `${video.viewsText} views`;
  return '';
}

export function publishedLabel(video) {
  return video.publishedText || timeAgo(video.published);
}

export function subscribersLabel(channel) {
  if (channel.subscribers != null) return plural(channel.subscribers, 'subscriber');
  if (channel.subscribersText) return /sub/i.test(channel.subscribersText) ? channel.subscribersText : `${channel.subscribersText} subscribers`;
  return '';
}

// "1:02:03" / "2:15" -> seconds
export function parseTimestamp(str) {
  if (!str) return 0;
  if (/^\d+$/.test(str)) return Number(str);
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(str);
  if (hms && str) return (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  return str.split(':').reduce((acc, part) => acc * 60 + (Number(part) || 0), 0);
}

// Turn plain text (descriptions, comments) into safe HTML with clickable
// links, timestamps and hashtags. Links to YouTube videos/channels stay in-app.
const TOKEN = /(https?:\/\/[^\s<>"']+)|(^|[\s(])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s),.])|(^|\s)(#[\p{L}\p{N}_]+)/gmu;

function internalHref(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1, 12);
    return /^[\w-]{11}$/.test(id) ? `/watch?v=${id}${url.searchParams.get('t') ? `&t=${parseTimestamp(url.searchParams.get('t'))}` : ''}` : null;
  }
  if (host !== 'youtube.com') return null;
  if (url.pathname === '/watch' && /^[\w-]{11}$/.test(url.searchParams.get('v') || '')) {
    const t = url.searchParams.get('t');
    return `/watch?v=${url.searchParams.get('v')}${t ? `&t=${parseTimestamp(t)}` : ''}`;
  }
  const shorts = /^\/(?:shorts|live)\/([\w-]{11})/.exec(url.pathname);
  if (shorts) return `/watch?v=${shorts[1]}`;
  const channel = /^\/channel\/([\w-]+)/.exec(url.pathname);
  if (channel) return `/channel/${channel[1]}`;
  return null;
}

export function linkify(text, { videoId } = {}) {
  if (!text) return '';
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    out += esc(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      // Don't swallow trailing punctuation into the URL.
      let url = m[1];
      const trail = /[.,!?;:)\]]+$/.exec(url)?.[0] || '';
      url = url.slice(0, url.length - trail.length);
      const internal = internalHref(url);
      out += internal
        ? `<a href="${esc(internal)}">${esc(url)}</a>`
        : `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url)}</a>`;
      out += esc(trail);
    } else if (m[3]) {
      const seconds = parseTimestamp(m[3]);
      out += esc(m[2]);
      out += videoId ? `<a href="/watch?v=${esc(videoId)}&t=${seconds}" data-seek="${seconds}">${esc(m[3])}</a>` : esc(m[3]);
    } else if (m[5]) {
      out += esc(m[4]) + `<a href="/results?search_query=${encodeURIComponent(m[5])}">${esc(m[5])}</a>`;
    }
  }
  return out + esc(text.slice(last));
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Calls `onVisible` when `el` scrolls near the viewport; returns a disconnect fn.
export function whenNearViewport(el, onVisible, rootMargin = '800px') {
  const observer = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) onVisible();
  }, { rootMargin });
  observer.observe(el);
  return () => observer.disconnect();
}

let toastTimer;
export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
