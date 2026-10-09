// Invidious API adapter: https://docs.invidious.io/api/
// Every function returns the normalized shapes documented in server/index.js.

const { fetchJson, UpstreamError } = require('../lib/http');
const { videoThumb, invidiousChannelImage } = require('../lib/images');
const { decodeEntities, toNumber, channelIdFromUrl } = require('../lib/text');
const { FAST_TIMEOUT_MS, SLOW_TIMEOUT_MS } = require('./timeouts');

const get = (instance, path, timeout = SLOW_TIMEOUT_MS) => fetchJson(`${instance}/api/v1${path}`, timeout);

// Pick the smallest thumbnail at least `minWidth` wide (or the largest available).
function pickImage(list, minWidth) {
  if (typeof list === 'string') return list;
  if (!Array.isArray(list) || !list.length) return '';
  const sorted = [...list].filter(t => t?.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find(t => (t.width || 0) >= minWidth) || sorted[sorted.length - 1])?.url || '';
}

function parseChannelRef(instance, item) {
  return {
    id: item.authorId || channelIdFromUrl(item.authorUrl),
    name: item.author || '',
    avatar: invidiousChannelImage(pickImage(item.authorThumbnails, 68), instance),
    verified: !!item.authorVerified,
  };
}

function parseVideo(instance, item) {
  const id = item.videoId;
  if (!id || !item.title) return null;
  return {
    type: 'video',
    id,
    title: item.title,
    thumbnail: videoThumb(id, { instance }),
    duration: item.lengthSeconds > 0 ? item.lengthSeconds : null,
    isLive: !!item.liveNow,
    isUpcoming: !!item.isUpcoming,
    views: toNumber(item.viewCount),
    viewsText: item.viewCountText || '',
    published: item.published ? item.published * 1000 : null,
    publishedText: item.publishedText || '',
    description: item.description || '',
    channel: parseChannelRef(instance, item),
  };
}

function parseChannelSummary(instance, item) {
  const id = item.authorId || channelIdFromUrl(item.authorUrl);
  if (!id) return null;
  return {
    type: 'channel',
    id,
    name: item.author || '',
    handle: item.channelHandle || '',
    avatar: invidiousChannelImage(pickImage(item.authorThumbnails, 176), instance),
    verified: !!item.authorVerified,
    subscribers: toNumber(item.subCount),
    videoCount: toNumber(item.videoCount),
    description: item.description || '',
  };
}

function parseItems(instance, items) {
  if (!Array.isArray(items)) throw new UpstreamError('Instance returned an unexpected response shape.', { type: 'bad_shape' });
  return items
    .map(item => {
      if (item.type === 'channel') return parseChannelSummary(instance, item);
      if (item.type === 'video' || (!item.type && item.videoId)) return parseVideo(instance, item);
      return null; // playlists, shorts shelves, etc.
    })
    .filter(Boolean);
}

// --- Endpoints -------------------------------------------------------------

async function check(instance) {
  const data = await get(instance, '/stats', FAST_TIMEOUT_MS);
  return { software: data.software || null };
}

async function trending(instance, { region }) {
  try {
    return { items: parseItems(instance, await get(instance, `/trending?region=${encodeURIComponent(region)}`)) };
  } catch (err) {
    // YouTube retired its trending page in 2025, so many instances now fail
    // here. /popular (what's being watched on that instance) is a decent stand-in.
    const items = parseItems(instance, await get(instance, '/popular'));
    if (!items.length) throw err;
    return { items, source: 'popular' };
  }
}

const SEARCH_TYPES = { all: 'all', videos: 'video', channels: 'channel' };

async function search(instance, { q, type, sort, date, duration, continuation }) {
  const page = Math.max(1, parseInt(continuation, 10) || 1);
  const params = new URLSearchParams({ q, page: String(page), type: SEARCH_TYPES[type] || 'all' });
  if (sort) params.set('sort', sort);
  if (date) params.set('date', date);
  if (duration) params.set('duration', duration);
  const items = parseItems(instance, await get(instance, `/search?${params}`));
  return { items, continuation: items.length ? String(page + 1) : null };
}

async function suggestions(instance, q) {
  const data = await get(instance, `/search/suggestions?q=${encodeURIComponent(q)}`, FAST_TIMEOUT_MS);
  return (data.suggestions || []).map(s => decodeEntities(String(s)));
}

// Muxed (audio+video) streams the browser can play in a plain <video>.
// local=true makes the instance proxy them; YouTube's own URLs are locked
// to the instance's IP and wouldn't play from ours anyway.
function parseStreams(instance, formats) {
  return (formats || [])
    .filter(f => f.url && /^video\//.test(f.type || ''))
    .map(f => ({
      url: f.url.startsWith('/') ? instance + f.url : f.url,
      quality: f.qualityLabel || f.resolution || '',
      mime: (f.type || '').split(';')[0],
    }))
    .sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
}

async function video(instance, id) {
  const v = await get(instance, `/videos/${id}?local=true`);
  const channel = parseChannelRef(instance, v);
  return {
    id: v.videoId || id,
    title: v.title || '',
    description: v.description || '',
    thumbnail: videoThumb(id, { instance }),
    published: v.published ? v.published * 1000 : null,
    publishedText: v.publishedText || '',
    views: toNumber(v.viewCount),
    likes: toNumber(v.likeCount) || null,
    duration: v.lengthSeconds > 0 ? v.lengthSeconds : null,
    isLive: !!v.liveNow,
    keywords: Array.isArray(v.keywords) ? v.keywords.slice(0, 20) : [],
    category: v.genre || '',
    channel: {
      ...channel,
      avatar: invidiousChannelImage(pickImage(v.authorThumbnails, 88), instance),
      subscribersText: v.subCountText || '',
    },
    related: (v.recommendedVideos || []).map(r => parseVideo(instance, r)).filter(Boolean),
    streams: parseStreams(instance, v.formatStreams),
  };
}

function parseComment(instance, c) {
  return {
    id: c.commentId,
    text: c.content || '',
    publishedText: c.publishedText || '',
    likes: toNumber(c.likeCount) || 0,
    pinned: !!c.isPinned,
    hearted: !!c.creatorHeart,
    edited: !!c.isEdited,
    author: {
      id: c.authorId || channelIdFromUrl(c.authorUrl),
      name: c.author || '',
      avatar: invidiousChannelImage(c.authorThumbnail || pickImage(c.authorThumbnails, 48), instance),
      isOwner: !!c.authorIsChannelOwner,
      verified: !!c.verified,
    },
    replyCount: toNumber(c.replies?.replyCount) || 0,
    repliesToken: c.replies?.continuation || null,
  };
}

async function comments(instance, id, { sort, continuation }) {
  const params = new URLSearchParams({ sort_by: sort === 'new' ? 'new' : 'top' });
  if (continuation) params.set('continuation', continuation);
  const data = await get(instance, `/comments/${id}?${params}`);
  return {
    count: toNumber(data.commentCount),
    items: (data.comments || []).map(c => parseComment(instance, c)),
    continuation: data.continuation || null,
    sortable: true,
  };
}

function parseChannelVideos(instance, list, channel) {
  return (list || [])
    .map(v => parseVideo(instance, v))
    .filter(Boolean)
    .map(v => ({ ...v, channel: { ...v.channel, avatar: v.channel.avatar || channel?.avatar || '' } }));
}

async function channelVideos(instance, id, { continuation, channel } = {}) {
  const qs = continuation ? `?continuation=${encodeURIComponent(continuation)}` : '';
  const data = await get(instance, `/channels/${id}/videos${qs}`);
  return { items: parseChannelVideos(instance, data.videos, channel), continuation: data.continuation || null };
}

async function channel(instance, id) {
  const [infoResult, videosResult] = await Promise.allSettled([get(instance, `/channels/${id}`), get(instance, `/channels/${id}/videos`)]);
  if (infoResult.status === 'rejected') throw infoResult.reason;
  const c = infoResult.value;

  const info = {
    id: c.authorId || id,
    name: c.author || '',
    avatar: invidiousChannelImage(pickImage(c.authorThumbnails, 176), instance),
    banner: invidiousChannelImage(pickImage(c.authorBanners, 1280), instance),
    verified: !!c.authorVerified,
    subscribers: toNumber(c.subCount),
    description: c.description || '',
    tags: Array.isArray(c.tags) ? c.tags.slice(0, 20) : [],
    joined: c.joined ? c.joined * 1000 : null,
    totalViews: toNumber(c.totalViews) || null,
  };

  let videos;
  if (videosResult.status === 'fulfilled') {
    videos = { items: parseChannelVideos(instance, videosResult.value.videos, info), continuation: videosResult.value.continuation || null };
  } else {
    videos = { items: parseChannelVideos(instance, c.latestVideos, info), continuation: null };
  }
  return { ...info, videos };
}

module.exports = { check, trending, search, suggestions, video, comments, channel, channelVideos };
