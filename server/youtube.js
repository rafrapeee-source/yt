// Talks to YouTube's own internal API ("InnerTube", the JSON API youtube.com
// itself uses) through the youtubei.js library, and converts its responses
// into the small, stable shapes the frontend uses:
//
//   Video   { type:'video', id, title, thumbnail, duration, isLive, viewsText,
//             publishedText, description, channel:{ id, name, avatar, verified } }
//   Channel { type:'channel', id, name, handle, avatar, subscribersText, videoCountText, description }
//   Page    { items: [...], continuation }  — send `continuation` back for the next page.
//
// Only the metadata endpoints are used (search, next, browse). Playback
// happens in the visitor's browser through the youtube-nocookie.com embed, so
// the server never touches video streams (no /player calls, no bandwidth cost).

const { youtubeApiHost } = require('./config');

class YouTubeError extends Error {
  constructor(message, status = 502, type = 'upstream_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

// --- Client setup ------------------------------------------------------------

let clientPromise;

// youtubei.js is ESM-only; load it once and share one session.
function client() {
  clientPromise ??= (async () => {
    const { Innertube, Log } = await import('youtubei.js');
    Log.setLevel(Log.Level.NONE);
    return Innertube.create({
      fetch: apiFetch,
      generate_session_locally: true, // no extra round trip to youtube.com on startup
      retrieve_player: false, // the player script is only needed for streams, which we don't use
      lang: 'en',
      location: 'US',
    });
  })().catch(err => {
    clientPromise = null; // let the next request retry
    throw err;
  });
  return clientPromise;
}

// InnerTube is served both at www.youtube.com/youtubei/ and at
// youtubei.googleapis.com/youtubei/. The latter is the default: it's the
// same API, and it stays reachable on networks that block youtube.com.
const API_PREFIX = 'https://www.youtube.com/youtubei/';
const REPLACEMENT_PREFIX = `https://${youtubeApiHost}/youtubei/`;

function apiFetch(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(API_PREFIX) || API_PREFIX === REPLACEMENT_PREFIX) return fetch(input, init);
  const rewritten = REPLACEMENT_PREFIX + url.slice(API_PREFIX.length);
  return typeof input === 'object' && !(input instanceof URL) ? fetch(new Request(rewritten, input), init) : fetch(rewritten, init);
}

// Turns library/network failures into errors the UI can show.
async function call(label, fn) {
  try {
    return await fn(await client());
  } catch (err) {
    if (err instanceof YouTubeError) throw err;
    const msg = String(err?.message || err);
    if (/status code 404/.test(msg)) throw new YouTubeError(`${label}: not found.`, 404, 'not_found');
    if (/status code 429/.test(msg)) throw new YouTubeError('YouTube is rate-limiting this server. Try again in a minute.', 503, 'rate_limited');
    if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/.test(msg)) throw new YouTubeError(`Couldn't reach YouTube (${msg}).`, 502, 'network_error');
    console.error(`[youtube] ${label}:`, msg);
    throw new YouTubeError(`YouTube request failed (${label}).`, 502, 'upstream_error');
  }
}

// --- Generic helpers ------------------------------------------------------------

const text = t => (t == null ? '' : typeof t === 'string' ? t : typeof t.toString === 'function' && t.toString !== Object.prototype.toString ? t.toString() : t.text || '');

const https = url => (url?.startsWith('//') ? 'https:' + url : url || '');

// Smallest image at least `minWidth` wide, or the largest available.
function pickImage(list, minWidth) {
  if (!Array.isArray(list) || !list.length) return '';
  const sorted = list.filter(i => i?.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  return https((sorted.find(i => (i.width || 0) >= minWidth) || sorted.at(-1))?.url);
}

// Channel avatars are served at any size via the "=s<px>" suffix.
const avatarUrl = (url, size = 88) => https(url).replace(/=s\d+(-|$)/, `=s${size}$1`);

// "1.2M" / "324K" / "962" -> number (approximate for K/M/B)
function parseCount(str) {
  const m = /([\d.,]+)\s*([KMB])?/i.exec(String(str || ''));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase()] || 1));
}

// "1:02:03" -> 3723
function parseDuration(str) {
  if (!/^\d+(:\d+)+$/.test(str || '')) return null;
  return str.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

// Text with links restored: YouTube shortens long URLs in descriptions and
// comments ("https://example.com/very-lo..."), and wraps them in its
// /redirect?q= tracker. Use the real target instead.
function richText(t) {
  if (!t) return '';
  if (!Array.isArray(t.runs)) return text(t);
  return t.runs
    .map(run => {
      const url = run.endpoint?.payload?.url;
      if (!url) return run.text;
      let target = url;
      try {
        const parsed = new URL(url, 'https://www.youtube.com');
        if (parsed.pathname === '/redirect') target = parsed.searchParams.get('q') || url;
        else if (!/^https?:/i.test(url)) return run.text; // internal link (/watch, /channel, #hashtag)
      } catch {
        return run.text;
      }
      return /^https?:\/\//i.test(run.text) || /[.…]$/.test(run.text.trim()) ? target : run.text;
    })
    .join('');
}

// Depth-first search through a parsed response for nodes of the given types.
function collect(root, types, { skip = [] } = {}) {
  const found = [];
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach(walk);
    // youtubei.js wraps some children in a "SuperParsedResult" whose value is
    // a private field, invisible to Object.entries.
    if (typeof node.is_null === 'boolean' && typeof node.array === 'function') {
      if (!node.is_null) walk(node.is_array ? node.array() : node.item());
      return;
    }
    if (types.includes(node.type)) {
      found.push(node);
      return;
    }
    if (skip.includes(node.type)) return;
    for (const [key, value] of Object.entries(node)) if (!key.endsWith('_memo')) walk(value);
  };
  walk(root);
  return found;
}

function continuationToken(item) {
  const endpoint = item?.button?.endpoint || item?.endpoint;
  return endpoint?.payload?.token || endpoint?.payload?.continuationCommand?.token || null;
}

// Items carried by a continuation response ("append" / "reload" actions).
function continuationContents(response) {
  return [
    ...(response.on_response_received_actions || []),
    ...(response.on_response_received_endpoints || []),
    ...(response.on_response_received_commands || []),
  ].flatMap(action => action.contents || []);
}

const VIDEO_NODES = ['Video', 'CompactVideo', 'GridVideo', 'LockupView'];

// --- Node -> normalized shapes ---------------------------------------------

function fromVideoNode(v) {
  const id = v.video_id || v.id;
  if (!id) return null;
  const badgeLive = (v.badges || []).some(b => /live/i.test(b.label || b.style || ''));
  const length = text(v.length_text) || text(v.duration?.text);
  return {
    type: 'video',
    id,
    title: text(v.title),
    thumbnail: pickImage(v.thumbnails, 320),
    duration: v.duration?.seconds || parseDuration(length),
    isLive: !!v.is_live || badgeLive || /watching/i.test(text(v.view_count)),
    viewsText: text(v.short_view_count) || text(v.view_count),
    publishedText: text(v.published),
    description: (v.snippets || []).map(s => text(s.text)).join(' ') || text(v.description_snippet) || text(v.description),
    channel: {
      id: v.author?.id || '',
      name: v.author?.name || '',
      avatar: avatarUrl(pickImage(v.author?.thumbnails, 68), 88),
      verified: !!(v.author?.is_verified || v.author?.is_verified_artist),
    },
  };
}

// LockupView is YouTube's newer generic card (related videos, channel uploads).
function fromLockup(l) {
  if (l.content_type && l.content_type !== 'VIDEO') return null; // playlists, mixes
  const id = l.content_id;
  if (!id) return null;
  const badges = (l.content_image?.overlays || []).flatMap(o => o.badges || []);
  const badgeText = badges.map(b => b.text || '').filter(Boolean);
  const durationText = badgeText.find(t => /^\d+(:\d+)+$/.test(t));
  const isLive = badgeText.some(t => /^live$/i.test(t)) || badges.some(b => /LIVE/.test(b.badge_style || ''));

  const rows = (l.metadata?.metadata?.metadata_rows || []).map(r => (r.metadata_parts || []).map(p => text(p.text)).filter(Boolean));
  const stats = rows.length > 1 ? rows.at(-1) : rows[0] || [];
  const channelName = rows.length > 1 ? rows[0][0] || '' : '';
  const viewsText = stats.find(s => /view|watching/i.test(s)) || stats.find(s => /^[\d.,]+[KMB]?$/i.test(s)) || '';
  const publishedText = stats.find(s => s !== viewsText && /ago|stream|premier|^\w{3} \d/i.test(s)) || '';

  const avatar = l.metadata?.image?.avatar?.image || l.metadata?.image?.image;
  const channelId = l.metadata?.image?.renderer_context?.command_context?.on_tap?.payload?.browseId || '';

  return {
    type: 'video',
    id,
    title: text(l.metadata?.title),
    thumbnail: pickImage(l.content_image?.image, 320),
    duration: parseDuration(durationText),
    isLive: isLive || /watching/i.test(viewsText),
    viewsText,
    publishedText,
    description: '',
    channel: { id: channelId, name: channelName, avatar: avatarUrl(pickImage(avatar, 68), 88), verified: false },
  };
}

function fromChannelNode(c) {
  const id = c.id || c.author?.id;
  if (!id) return null;
  // YouTube puts the @handle in subscriber_count and the subscriber count in
  // video_count for some layouts; sort them out by content.
  const parts = [text(c.subscriber_count), text(c.video_count)].filter(Boolean);
  const handle = parts.find(p => p.startsWith('@')) || '';
  const subs = parts.find(p => /subscriber/i.test(p)) || '';
  const videos = parts.find(p => /video/i.test(p)) || '';
  return {
    type: 'channel',
    id,
    name: c.author?.name || '',
    handle,
    avatar: avatarUrl(pickImage(c.author?.thumbnails, 68), 176),
    verified: !!(c.author?.is_verified || c.author?.is_verified_artist),
    subscribersText: subs,
    videoCountText: videos,
    description: text(c.description_snippet),
  };
}

function toItem(node) {
  if (node.type === 'LockupView') return fromLockup(node);
  if (node.type === 'Channel') return fromChannelNode(node);
  if (VIDEO_NODES.includes(node.type)) return fromVideoNode(node);
  return null;
}

const toItems = nodes => nodes.map(toItem).filter(item => item && (item.type !== 'video' || item.title));

// Continuation tokens are tagged with the endpoint they belong to, so the
// frontend can treat them as opaque strings.
const pack = (endpoint, token) => (token ? `${endpoint}:${token}` : null);
function unpack(packed, expected) {
  const i = (packed || '').indexOf(':');
  const endpoint = packed.slice(0, i);
  if (i < 0 || endpoint !== expected) throw new YouTubeError('Invalid continuation token.', 400, 'bad_request');
  return packed.slice(i + 1);
}

// --- Search ------------------------------------------------------------------------

const SEARCH_TYPES = { videos: 'video', channels: 'channel' };

async function search({ q, type, sort, date, duration, continuation }) {
  return call('search', async yt => {
    let response;
    if (continuation) {
      response = await yt.actions.execute('/search', { continuation: unpack(continuation, 'search'), parse: true });
    } else {
      const filters = {};
      if (SEARCH_TYPES[type]) filters.type = SEARCH_TYPES[type];
      if (sort) filters.sort_by = sort;
      if (date) filters.upload_date = date;
      if (duration) filters.duration = duration;
      response = (await yt.search(q, filters)).page;
    }
    // Skip shelves ("People also watched", Shorts rows) like YouTube's own
    // list view does; keep plain results.
    const nodes = collect(response, ['Video', 'Channel', 'LockupView', 'ContinuationItem'], { skip: ['Shelf', 'ReelShelf', 'GridShelfView', 'HorizontalCardList', 'HorizontalShelfView', 'OfficialCardView'] });
    const token = continuationToken(nodes.filter(n => n.type === 'ContinuationItem').at(-1));
    return { items: toItems(nodes.filter(n => n.type !== 'ContinuationItem')), continuation: pack('search', token) };
  });
}

// YouTube's own autocomplete. The google.com host is used because the
// youtube.com one is blocked on some networks; both return the same list.
async function suggestions(q) {
  try {
    const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return Array.isArray(data?.[1]) ? data[1].map(String) : [];
  } catch {
    return [];
  }
}

// --- Video page ------------------------------------------------------------------

async function video(id) {
  return call('video', async yt => {
    const response = await yt.actions.execute('/next', { videoId: id, parse: true });
    const two = response.contents?.item?.();
    const results = two?.results || [];
    const primary = results.find(n => n.type === 'VideoPrimaryInfo');
    const secondary = results.find(n => n.type === 'VideoSecondaryInfo');
    if (!primary) throw new YouTubeError('This video is unavailable.', 404, 'not_found');

    const owner = secondary?.owner;
    const likeNode = collect(primary.menu, ['SegmentedLikeDislikeButtonView', 'SegmentedLikeDislikeButton'])[0];
    const likes = likeNode?.like_count || parseCount(likeNode?.short_like_count) || null;
    const hashtags = text(primary.super_title_link).split(/\s+/).filter(t => t.startsWith('#'));

    const related = two?.secondary_results || [];
    const relatedNodes = collect(related, [...VIDEO_NODES, 'ContinuationItem']);
    const commentsSection = results.find(n => n.type === 'ItemSection' && n.target_id === 'comments-section');
    const commentsToken = continuationToken(collect(commentsSection, ['ContinuationItem'])[0]);

    return {
      id,
      title: text(primary.title),
      description: richText(secondary?.description) || text(secondary?.attributed_description),
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      viewCount: primary.view_count?.original_view_count ?? parseCount(text(primary.view_count?.view_count)),
      viewsText: text(primary.view_count?.view_count),
      isLive: !!primary.view_count?.is_live,
      dateText: text(primary.published), // "Oct 25, 2009"
      publishedText: text(primary.relative_date), // "16 years ago"
      likes,
      keywords: hashtags.map(h => h.slice(1)),
      channel: {
        id: owner?.author?.id || '',
        name: owner?.author?.name || text(owner?.title),
        avatar: avatarUrl(pickImage(owner?.author?.thumbnails, 88), 88),
        verified: !!(owner?.author?.is_verified || owner?.author?.is_verified_artist),
        subscribersText: text(owner?.subscriber_count),
      },
      related: toItems(relatedNodes.filter(n => n.type !== 'ContinuationItem')),
      relatedContinuation: pack('next', continuationToken(relatedNodes.filter(n => n.type === 'ContinuationItem').at(-1))),
      commentsToken: pack('next', commentsToken),
    };
  });
}

async function relatedPage(continuation) {
  return call('related', async yt => {
    const response = await yt.actions.execute('/next', { continuation: unpack(continuation, 'next'), parse: true });
    const nodes = collect(continuationContents(response), [...VIDEO_NODES, 'ContinuationItem']);
    return {
      items: toItems(nodes.filter(n => n.type !== 'ContinuationItem')),
      continuation: pack('next', continuationToken(nodes.filter(n => n.type === 'ContinuationItem').at(-1))),
    };
  });
}

// --- Comments ------------------------------------------------------------------------

function fromComment(thread) {
  const c = thread.comment || thread;
  if (!c?.comment_id) return null;
  const replies = thread.comment_replies_data;
  const repliesItem = replies && collect([replies.contents, replies.sub_threads], ['ContinuationItem'])[0];
  const published = c.published_time || '';
  return {
    id: c.comment_id,
    text: richText(c.content),
    publishedText: published.replace(/\s*\(edited\)/, ''),
    edited: /\(edited\)/.test(published),
    likes: parseCount(c.like_count) || 0,
    pinned: !!c.is_pinned,
    hearted: !!c.is_hearted,
    author: {
      id: c.author?.id || '',
      name: c.author?.name || '',
      avatar: avatarUrl(c.author?.avatar_thumbnail_url || pickImage(c.author?.thumbnails, 48), 88),
      isOwner: !!c.author_is_channel_owner,
      verified: !!(c.author?.is_verified || c.author?.is_verified_artist),
    },
    replyCount: parseCount(c.reply_count) || 0,
    repliesToken: pack('next', continuationToken(repliesItem)),
  };
}

// Pages of comments (or replies) from a /next continuation.
async function commentsPage(token) {
  return call('comments', async yt => {
    const response = await yt.actions.execute('/next', { continuation: unpack(token, 'next'), parse: true });
    const contents = continuationContents(response);
    const header = collect(contents, ['CommentsHeader'])[0];
    // Don't descend into threads: their own reply tokens aren't page tokens.
    const nodes = collect(contents, ['CommentThread', 'CommentView', 'ContinuationItem'], { skip: ['CommentsHeader'] });
    const sortTokens = {};
    for (const item of header?.sort_menu?.sub_menu_items || []) {
      const key = /new/i.test(item.title) ? 'new' : 'top';
      sortTokens[key] = pack('next', item.continuation || item.endpoint?.payload?.token);
    }
    return {
      countText: text(header?.comments_count),
      count: parseCount(text(header?.comments_count)),
      items: nodes.filter(n => n.type !== 'ContinuationItem').map(fromComment).filter(Boolean),
      continuation: pack('next', continuationToken(nodes.filter(n => n.type === 'ContinuationItem').at(-1))),
      sortTokens,
    };
  });
}

// First page: the token comes from the video page; "newest first" needs one
// more hop through the sort menu of the first page.
async function comments(id, { sort, continuation, videoToken }) {
  if (continuation) return commentsPage(continuation);
  if (!videoToken) return { items: [], continuation: null, disabled: true };
  const first = await commentsPage(videoToken);
  if (sort === 'new' && first.sortTokens.new) {
    const newest = await commentsPage(first.sortTokens.new);
    return { ...newest, countText: newest.countText || first.countText, count: newest.count ?? first.count, sortable: true };
  }
  return { ...first, sortable: !!first.sortTokens.new };
}

// --- Channel ------------------------------------------------------------------------

async function channel(id) {
  return call('channel', async yt => {
    const ch = await yt.getChannel(id);
    const meta = ch.metadata || {};
    const header = ch.header?.content || ch.header;
    const rows = (header?.metadata?.metadata_rows || []).flatMap(r => (r.metadata_parts || []).map(p => text(p.text)));

    let videos = { items: [], continuation: null };
    if (ch.has_videos) {
      const tab = await ch.getVideos();
      // Only the tab body: the header also carries continuation tokens (e.g. the About panel).
      videos = pageFromBrowse(tab.current_tab);
    }
    const info = {
      id: meta.external_id || id,
      name: meta.title || text(header?.title?.text),
      handle: rows.find(r => r.startsWith('@')) || '',
      avatar: avatarUrl(pickImage(header?.image?.avatar?.image || meta.avatar, 176), 176),
      banner: pickImage(header?.banner?.image, 1280),
      verified: false,
      subscribersText: rows.find(r => /subscriber/i.test(r)) || '',
      videoCountText: rows.find(r => /video/i.test(r)) || '',
      description: meta.description || '',
      tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 20) : [],
    };
    videos.items = videos.items.map(v => ({ ...v, channel: { ...v.channel, id: info.id, name: info.name, avatar: info.avatar } }));
    return { ...info, videos };
  });
}

function pageFromBrowse(response) {
  const nodes = collect(response, [...VIDEO_NODES, 'ContinuationItem'], { skip: ['ReelShelf', 'Shelf'] });
  return {
    items: toItems(nodes.filter(n => n.type !== 'ContinuationItem')),
    continuation: pack('browse', continuationToken(nodes.filter(n => n.type === 'ContinuationItem').at(-1))),
  };
}

async function channelVideos(id, { continuation, channel: ch }) {
  if (!continuation) return (await channel(id)).videos;
  return call('channel videos', async yt => {
    const response = await yt.actions.execute('/browse', { continuation: unpack(continuation, 'browse'), parse: true });
    const page = pageFromBrowse(continuationContents(response));
    page.items = page.items.map(v => ({ ...v, channel: { ...v.channel, id, name: v.channel.name || ch?.name || '', avatar: v.channel.avatar || ch?.avatar || '' } }));
    return page;
  });
}

// Create the session ahead of the first request (saves ~1-2 s on it).
function warmUp() {
  client().catch(err => console.error('[youtube] warm-up failed:', err.message));
}

module.exports = { warmUp, YouTubeError, search, suggestions, video, relatedPage, comments, channel, channelVideos, parseCount };
