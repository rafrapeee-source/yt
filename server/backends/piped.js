// Piped API adapter: https://docs.piped.video/docs/api-documentation/
// Piped's API host is usually separate from its web frontend (pipedapi.* vs
// piped.*). Pagination uses opaque "nextpage" JSON strings, which we pass
// through to the frontend as `continuation`.

const { fetchJson, UpstreamError } = require('../lib/http');
const { videoThumb, pipedImage } = require('../lib/images');
const { htmlToText, toNumber, channelIdFromUrl, videoIdFromUrl } = require('../lib/text');
const { SLOW_TIMEOUT_MS, FAST_TIMEOUT_MS } = require('./timeouts');

const get = (instance, path, timeout = SLOW_TIMEOUT_MS) => fetchJson(`${instance}${path}`, timeout);

function parseStream(item) {
  const id = videoIdFromUrl(item.url);
  if (!id || !item.title) return null;
  const uploaded = item.uploaded > 0 ? item.uploaded : null;
  return {
    type: 'video',
    id,
    title: item.title,
    thumbnail: videoThumb(id, { primary: item.thumbnail }),
    duration: item.duration > 0 ? item.duration : null,
    // Piped uses duration -1 both for live streams and for "unknown"; only
    // live streams also lack an upload date.
    isLive: item.duration === -1 && !uploaded && !item.uploadedDate,
    isShort: !!item.isShort,
    views: item.views >= 0 ? item.views : null,
    viewsText: '',
    published: uploaded,
    publishedText: item.uploadedDate || '',
    description: item.shortDescription || '',
    channel: {
      id: channelIdFromUrl(item.uploaderUrl),
      name: item.uploaderName || '',
      avatar: pipedImage(item.uploaderAvatar),
      verified: !!item.uploaderVerified,
    },
  };
}

function parseChannelSummary(item) {
  const id = channelIdFromUrl(item.url);
  if (!id) return null;
  return {
    type: 'channel',
    id,
    name: item.name || '',
    handle: '',
    avatar: pipedImage(item.thumbnail),
    verified: !!item.verified,
    subscribers: item.subscribers >= 0 ? item.subscribers : null,
    videoCount: item.videos >= 0 ? item.videos : null,
    description: item.description || '',
  };
}

function parseItems(items) {
  if (!Array.isArray(items)) throw new UpstreamError('Instance returned an unexpected response shape.', { type: 'bad_shape' });
  return items
    .map(item => {
      if (item.type === 'channel') return parseChannelSummary(item);
      if (!item.type || item.type === 'stream') return parseStream(item);
      return null;
    })
    .filter(Boolean);
}

// --- Endpoints -------------------------------------------------------------

async function trending(instance, { region }) {
  return { items: parseItems(await get(instance, `/trending?region=${encodeURIComponent(region)}`)) };
}

// Piped has no lightweight stats endpoint; trending is a good "is it up and
// actually talking to YouTube" probe, and it's shared with the home page cache.
async function check(instance, { region = 'US' } = {}) {
  await trending(instance, { region });
  return { software: { name: 'piped' } };
}

const SEARCH_FILTERS = { all: 'all', videos: 'videos', channels: 'channels' };

async function search(instance, { q, type, continuation }) {
  const filter = SEARCH_FILTERS[type] || 'all';
  const base = `q=${encodeURIComponent(q)}&filter=${filter}`;
  const data = continuation
    ? await get(instance, `/nextpage/search?${base}&nextpage=${encodeURIComponent(continuation)}`)
    : await get(instance, `/search?${base}`);
  return { items: parseItems(data.items), continuation: data.nextpage || null };
}

async function suggestions(instance, q) {
  const data = await get(instance, `/suggestions?query=${encodeURIComponent(q)}`, FAST_TIMEOUT_MS);
  return Array.isArray(data) ? data.map(String) : [];
}

// Muxed (audio+video) streams the browser can play in a plain <video>, best
// first. Piped already routes YouTube's URLs through its own proxy. "LBRY"
// entries are Odysee mirrors of the same video, kept as an alternative.
function parseStreams(list) {
  const height = s => parseInt(s.quality, 10) || 0;
  return (list || [])
    .filter(s => s.url && !s.videoOnly && /^video\//.test(s.mimeType || ''))
    .sort((a, b) => (a.quality === 'LBRY') - (b.quality === 'LBRY') || height(b) - height(a))
    .map(s => ({ url: s.url, quality: s.quality === 'LBRY' ? 'Odysee mirror' : s.quality, mime: s.mimeType }));
}

async function video(instance, id) {
  const v = await get(instance, `/streams/${id}`);
  const published = Date.parse(v.uploadDate) || (v.uploaded > 0 ? v.uploaded : null);
  return {
    id,
    title: v.title || '',
    description: htmlToText(v.description),
    thumbnail: videoThumb(id, { primary: v.thumbnailUrl }),
    published,
    publishedText: '',
    views: v.views >= 0 ? v.views : null,
    likes: v.likes > 0 ? v.likes : null,
    duration: v.duration > 0 ? v.duration : null,
    isLive: !!v.livestream,
    keywords: Array.isArray(v.tags) ? v.tags.slice(0, 20) : [],
    category: v.category || '',
    channel: {
      id: channelIdFromUrl(v.uploaderUrl),
      name: v.uploader || '',
      avatar: pipedImage(v.uploaderAvatar),
      verified: !!v.uploaderVerified,
      subscribers: v.uploaderSubscriberCount >= 0 ? v.uploaderSubscriberCount : null,
      subscribersText: '',
    },
    related: (v.relatedStreams || []).filter(r => !r.type || r.type === 'stream').map(parseStream).filter(Boolean),
    streams: parseStreams(v.videoStreams),
  };
}

function parseComment(c) {
  return {
    id: c.commentId,
    text: htmlToText(c.commentText),
    publishedText: c.commentedTime || '',
    likes: c.likeCount > 0 ? c.likeCount : 0,
    pinned: !!c.pinned,
    hearted: !!c.hearted,
    edited: false,
    author: {
      id: channelIdFromUrl(c.commentorUrl),
      name: c.author || '',
      avatar: pipedImage(c.thumbnail),
      isOwner: !!c.channelOwner,
      verified: !!c.verified,
    },
    replyCount: c.replyCount > 0 ? c.replyCount : 0,
    repliesToken: c.repliesPage || null,
  };
}

// Piped doesn't support choosing the comment sort order.
async function comments(instance, id, { continuation }) {
  const data = continuation
    ? await get(instance, `/nextpage/comments/${id}?nextpage=${encodeURIComponent(continuation)}`)
    : await get(instance, `/comments/${id}`);
  if (data.disabled) return { count: 0, items: [], continuation: null, disabled: true, sortable: false };
  return {
    count: toNumber(data.commentCount),
    items: (data.comments || []).map(parseComment),
    continuation: data.nextpage || null,
    sortable: false,
  };
}

function withChannelAvatar(items, channel) {
  return items.map(v => ({
    ...v,
    channel: { ...v.channel, name: v.channel.name || channel.name, avatar: v.channel.avatar || channel.avatar },
  }));
}

// Some Piped versions return an empty first page of uploads (YouTube moved
// them into a separate tab). As a last resort, search for the channel's name
// and keep only results it uploaded, so the page isn't blank.
async function uploadsViaSearch(instance, channel) {
  const { items } = await search(instance, { q: channel.name, type: 'videos' });
  return items.filter(v => v.type === 'video' && v.channel.id === channel.id);
}

async function channelVideos(instance, id, { continuation, channel } = {}) {
  if (!continuation) {
    const full = await channelInternal(instance, id);
    return full.videos;
  }
  const data = await get(instance, `/nextpage/channel/${id}?nextpage=${encodeURIComponent(continuation)}`);
  return { items: withChannelAvatar(parseItems(data.relatedStreams || []), channel || {}), continuation: data.nextpage || null };
}

async function channelInternal(instance, id) {
  const c = await get(instance, `/channel/${id}`);
  const info = {
    id: c.id || id,
    name: c.name || '',
    avatar: pipedImage(c.avatarUrl),
    banner: pipedImage(c.bannerUrl),
    verified: !!c.verified,
    subscribers: c.subscriberCount >= 0 ? c.subscriberCount : null,
    description: c.description || '',
    tags: [],
    joined: null,
    totalViews: null,
  };

  let items = withChannelAvatar(parseItems(c.relatedStreams || []), info);
  let continuation = c.nextpage || null;
  let source;

  if (!items.length && continuation) {
    try {
      const next = await get(instance, `/nextpage/channel/${info.id}?nextpage=${encodeURIComponent(continuation)}`);
      items = withChannelAvatar(parseItems(next.relatedStreams || []), info);
      continuation = items.length ? next.nextpage || null : null;
    } catch {
      continuation = null;
    }
  }
  if (!items.length && info.name) {
    try {
      items = withChannelAvatar(await uploadsViaSearch(instance, info), info);
      continuation = null;
      source = 'search';
    } catch {
      /* leave empty */
    }
  }
  return { ...info, videos: { items, continuation, source } };
}

module.exports = { check, trending, search, suggestions, video, comments, channel: channelInternal, channelVideos };
