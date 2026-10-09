// Markup builders and small widgets reused across views. Every value from the
// API goes through esc() — nothing upstream is inserted as raw HTML.

import { esc, html, formatDuration, viewsLabel, publishedLabel, subscribersLabel, whenNearViewport } from './util.js';
import { icon } from './icons.js';
import { isSubscribed } from './store.js';
import { rememberVideos } from './api.js';

function hue(str = '') {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

export function avatar(channel, size = 36) {
  const name = channel?.name || '?';
  const initial = name.replace(/^@/, '').charAt(0).toUpperCase() || '?';
  const img = channel?.avatar ? `<img src="${esc(channel.avatar)}" alt="" loading="lazy" decoding="async" />` : '';
  return `<span class="avatar" style="--size:${size}px;--hue:${hue(name)}" aria-hidden="true"><span class="avatar-initial">${esc(initial)}</span>${img}</span>`;
}

const verifiedBadge = channel => (channel?.verified ? `<span class="verified" title="Verified">${icon('verified')}</span>` : '');

function channelLink(channel, cls = 'channel-name') {
  if (!channel?.name) return '';
  const inner = `<span class="ellipsis">${esc(channel.name)}</span>${verifiedBadge(channel)}`;
  return channel.id ? `<a class="${cls}" href="/channel/${esc(channel.id)}">${inner}</a>` : `<span class="${cls}">${inner}</span>`;
}

function thumbBadge(video) {
  if (video.isLive) return '<span class="thumb-badge live">LIVE</span>';
  if (video.isUpcoming) return '<span class="thumb-badge">UPCOMING</span>';
  const d = formatDuration(video.duration);
  return d ? `<span class="thumb-badge">${d}</span>` : '';
}

function thumb(video) {
  const img = video.thumbnail ? `<img src="${esc(video.thumbnail)}" alt="" loading="lazy" decoding="async" />` : '';
  return `<a class="thumb" href="/watch?v=${esc(video.id)}" tabindex="-1" aria-hidden="true">${img}${thumbBadge(video)}</a>`;
}

const meta = video => [viewsLabel(video), publishedLabel(video)].filter(Boolean).map(esc).join('<span class="dot">•</span>');

export function videoCard(video) {
  return `
    <article class="vcard">
      ${thumb(video)}
      <div class="vcard-body">
        ${video.channel?.id ? `<a href="/channel/${esc(video.channel.id)}" class="vcard-avatar" tabindex="-1">${avatar(video.channel, 36)}</a>` : ''}
        <div class="vcard-text">
          <h3 class="vtitle"><a href="/watch?v=${esc(video.id)}" title="${esc(video.title)}">${esc(video.title)}</a></h3>
          ${channelLink(video.channel)}
          <div class="vmeta">${meta(video)}</div>
        </div>
      </div>
    </article>`;
}

export function videoRow(video) {
  return `
    <article class="vrow">
      ${thumb(video)}
      <div class="vrow-text">
        <h3 class="vtitle"><a href="/watch?v=${esc(video.id)}" title="${esc(video.title)}">${esc(video.title)}</a></h3>
        <div class="vmeta">${meta(video)}</div>
        ${video.channel?.name ? `<div class="vrow-channel">${video.channel.id ? `<a href="/channel/${esc(video.channel.id)}" tabindex="-1">${avatar(video.channel, 24)}</a>` : ''}${channelLink(video.channel)}</div>` : ''}
        ${video.description ? `<p class="vrow-desc">${esc(video.description)}</p>` : ''}
      </div>
    </article>`;
}

export function videoCompact(video) {
  return `
    <article class="vcompact">
      ${thumb(video)}
      <div class="vcompact-text">
        <h3 class="vtitle"><a href="/watch?v=${esc(video.id)}" title="${esc(video.title)}">${esc(video.title)}</a></h3>
        ${channelLink(video.channel)}
        <div class="vmeta">${meta(video)}</div>
      </div>
    </article>`;
}

export function subscribeButton(channel) {
  if (!channel?.id) return '';
  const subbed = isSubscribed(channel.id);
  return `<button type="button" class="btn subscribe ${subbed ? 'subscribed' : ''}" data-sub-id="${esc(channel.id)}"
    data-sub-name="${esc(channel.name)}" data-sub-avatar="${esc(channel.avatar || '')}">${subbed ? 'Subscribed' : 'Subscribe'}</button>`;
}

export function channelRow(channel) {
  const facts = [channel.handle, subscribersLabel(channel), channel.videoCountText]
    .filter(Boolean)
    .map(esc)
    .join('<span class="dot">•</span>');
  return `
    <article class="crow">
      <a class="crow-avatar" href="/channel/${esc(channel.id)}" tabindex="-1">${avatar(channel, 136)}</a>
      <div class="crow-text">
        <h3><a href="/channel/${esc(channel.id)}">${esc(channel.name)}${verifiedBadge(channel)}</a></h3>
        <div class="vmeta">${facts}</div>
        ${channel.description ? `<p class="vrow-desc">${esc(channel.description)}</p>` : ''}
      </div>
      ${subscribeButton(channel)}
    </article>`;
}

export function renderItem(item, layout = 'grid') {
  if (item.type === 'channel') return channelRow(item);
  if (layout === 'row') return videoRow(item);
  if (layout === 'compact') return videoCompact(item);
  return videoCard(item);
}

export function skeletons(layout = 'grid', count = 12) {
  const one = {
    grid: '<div class="vcard skeleton"><div class="thumb"></div><div class="vcard-body"><span class="sk-circle"></span><div class="vcard-text"><span class="sk-line"></span><span class="sk-line short"></span></div></div></div>',
    row: '<div class="vrow skeleton"><div class="thumb"></div><div class="vrow-text"><span class="sk-line"></span><span class="sk-line short"></span><span class="sk-line short"></span></div></div>',
    compact: '<div class="vcompact skeleton"><div class="thumb"></div><div class="vcompact-text"><span class="sk-line"></span><span class="sk-line short"></span></div></div>',
  }[layout];
  return one.repeat(count);
}

export function spinner() {
  return '<div class="spinner" role="progressbar" aria-label="Loading"></div>';
}

// A friendly error panel with a retry action.
export function errorPanel(err, { onRetry, compactLayout = false } = {}) {
  const el = html(`
    <div class="error-panel ${compactLayout ? 'compact' : ''}" role="alert">
      ${icon('warning', 'error-icon')}
      <div>
        <p class="error-title">Something went wrong</p>
        <p class="error-message">${esc(err?.message || String(err))}</p>
        <div class="error-actions">
          ${onRetry ? `<button type="button" class="btn" data-act="retry">${icon('refresh')}Retry</button>` : ''}
        </div>
      </div>
    </div>`);
  el.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'retry') onRetry();
  });
  return el;
}

export function emptyState(title, message = '', iconName = 'search') {
  return `<div class="empty-state">${icon(iconName, 'empty-icon')}<h2>${esc(title)}</h2>${message ? `<p>${message}</p>` : ''}</div>`;
}

/**
 * Infinite-scrolling list. Persists its items in `ctx.state[stateKey]` so that
 * coming back to the page (browser Back) re-renders instantly at the same
 * scroll position instead of refetching.
 *
 * fetchPage(continuation) -> { items, continuation, ...extra }
 * Resolves once the first page is on screen.
 */
export function mountFeed(ctx, opts) {
  const {
    list,
    layout = 'grid',
    fetchPage,
    empty,
    filter = () => true,
    onFirstPage,
    onRendered,
    stateKey = 'feed',
    renderItems = items => items.map(i => renderItem(i, layout)).join(''),
    skeleton = skeletons(layout, layout === 'grid' ? 12 : 6),
    isAlive = () => ctx.alive,
  } = opts;

  const state = ctx.state[stateKey] || (ctx.state[stateKey] = { items: [], continuation: null, first: null, done: false });
  const footer = html('<div class="feed-footer"></div>');
  list.after(footer);
  let loading = false;
  let paused = false; // after an error, wait for the user to hit Retry
  const seen = new Set(state.items.map(i => i.type + i.id));

  const render = items => {
    rememberVideos(items);
    list.insertAdjacentHTML('beforeend', renderItems(items));
    onRendered?.(items);
  };
  const showEmpty = () => {
    if (!state.items.length) list.innerHTML = empty || emptyState('Nothing here');
  };

  async function loadMore() {
    if (loading || paused || state.done || !isAlive()) return;
    const started = !!state.first;
    loading = true;
    footer.innerHTML = started ? spinner() : '';
    if (!started) list.innerHTML = skeleton;
    try {
      const page = await fetchPage(started ? state.continuation : null);
      if (!isAlive()) return;
      if (!started) {
        list.innerHTML = '';
        state.first = { ...page, items: undefined };
        onFirstPage?.(state.first);
      }
      const fresh = (page.items || []).filter(i => filter(i) && !seen.has(i.type + i.id));
      fresh.forEach(i => seen.add(i.type + i.id));
      state.items.push(...fresh);
      render(fresh);
      state.continuation = page.continuation || null;
      // Stop when the source is exhausted, or a page brought nothing new
      // (guards against a source that repeats its last page).
      state.done = !state.continuation || (started && !fresh.length);
      footer.innerHTML = '';
      showEmpty();
    } catch (err) {
      if (!isAlive()) return;
      if (!started) list.innerHTML = '';
      paused = true;
      footer.innerHTML = '';
      footer.append(errorPanel(err, { onRetry: () => { paused = false; loadMore(); }, compactLayout: started }));
    } finally {
      loading = false;
    }
    // If the page still isn't filled, keep going.
    if (isAlive() && !paused && !state.done && footer.getBoundingClientRect().top < innerHeight + 800) loadMore();
  }

  ctx.onCleanup(whenNearViewport(footer, loadMore));

  if (state.first) {
    onFirstPage?.(state.first);
    render(state.items);
    showEmpty();
    return Promise.resolve();
  }
  return loadMore();
}
