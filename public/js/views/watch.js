import { api, peekVideo, playerUrls, rememberVideos, EMBED_ORIGIN } from '../api.js';
import { avatar, subscribeButton, videoCompact, skeletons, errorPanel, mountFeed, emptyState } from '../components.js';
import { addToHistory, getSettings } from '../store.js';
import { esc, html, linkify, compact, fullNumber, parseTimestamp, subscribersLabel, viewsLabel, publishedLabel, copyText, toast, whenNearViewport } from '../util.js';
import { icon } from '../icons.js';
import { navigate } from '../main.js';

const VIDEO_ID = /^[\w-]{11}$/;

export async function watchView(root, ctx) {
  const id = ctx.params.get('v') || '';
  if (!VIDEO_ID.test(id)) {
    root.innerHTML = emptyState('Video not found', 'That link doesn’t look like a valid video.', 'warning');
    return;
  }

  const preview = peekVideo(id);
  document.title = preview ? `${preview.title} - Findtube` : 'Findtube';

  root.append(
    html(`
    <div class="watch">
      <div class="player-wrap"><div class="player"></div></div>
      <div class="watch-meta"></div>
      <aside class="watch-related" aria-label="Related videos"><div class="related-list">${skeletons('compact', 8)}</div></aside>
      <section class="comments" aria-label="Comments"></section>
    </div>`)
  );

  const metaEl = root.querySelector('.watch-meta');
  const relatedEl = root.querySelector('.related-list');
  const commentsEl = root.querySelector('.comments');
  let details = null;

  // The player doesn't need the details, so it starts loading right away.
  const player = createPlayer(root.querySelector('.player'), id, ctx, {
    onEnded() {
      const next = details?.related?.[0];
      if (!next || !getSettings().autoplayNext) return;
      toast(`Up next: ${next.title}`);
      navigate(`/watch?v=${next.id}`);
    },
  });
  player.load(parseTimestamp(ctx.params.get('t')));

  const onSeek = e => {
    player.seek(e.detail);
    root.querySelector('.player').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  document.addEventListener('findtube:seek', onSeek);
  ctx.onCleanup(() => document.removeEventListener('findtube:seek', onSeek));

  if (preview) renderMeta(metaEl, preview, { partial: true });
  else metaEl.innerHTML = '<div class="meta-skeleton"><span class="sk-line"></span><span class="sk-line short"></span></div>';

  // Comments only load once they're scrolled near, saving a request for
  // people who just watch.
  ctx.onCleanup(whenNearViewport(commentsEl, () => {
    if (!commentsEl.dataset.mounted) {
      commentsEl.dataset.mounted = '1';
      mountComments(commentsEl, ctx, id);
    }
  }, '400px'));

  async function loadDetails() {
    try {
      const video = await api(`video/${id}`);
      if (!ctx.alive) return;
      details = video;
      document.title = `${video.title} - Findtube`;
      renderMeta(metaEl, video);
      mountRelated(relatedEl, ctx, video);
      addToHistory({ ...video, thumbnail: video.thumbnail || preview?.thumbnail });
    } catch (err) {
      if (!ctx.alive) return;
      if (preview) {
        renderMeta(metaEl, preview, { partial: true });
        addToHistory(preview);
      } else metaEl.innerHTML = '';
      const panel = errorPanel(
        { message: `Couldn't load the video details. ${err.message} The player above may still work.` },
        { onRetry: () => { panel.remove(); loadDetails(); }, compactLayout: true }
      );
      metaEl.append(panel);
      relatedFallback(relatedEl, ctx, id, preview);
    }
  }
  return loadDetails();
}

// --- Player ----------------------------------------------------------------------
//
// YouTube's privacy-enhanced embed (youtube-nocookie.com), loaded by the
// visitor's browser. With enablejsapi=1 the embed speaks a small postMessage
// protocol — the same one YouTube's iframe_api script uses — which lets us
// seek without reloading, notice when a video ends (autoplay next) and catch
// "embedding disabled" errors, without loading any script from youtube.com.

const PLAYER_ENDED = 0;
const EMBED_BLOCKED_ERRORS = new Set([101, 150, 152, 153]);

function createPlayer(el, id, ctx, { onEnded }) {
  let iframe = null;
  let ready = false;
  let handshake = null;

  const send = (func, args = []) => {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }), EMBED_ORIGIN);
  };

  function onMessage(e) {
    if (e.origin !== EMBED_ORIGIN || !iframe || e.source !== iframe.contentWindow) return;
    let data;
    try {
      data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    if (data.event === 'onReady' || data.event === 'initialDelivery') {
      if (!ready) {
        ready = true;
        clearInterval(handshake);
        send('addEventListener', ['onStateChange']);
        send('addEventListener', ['onError']);
      }
    } else if (data.event === 'onStateChange' && data.info === PLAYER_ENDED) {
      onEnded();
    } else if (data.event === 'infoDelivery' && data.info?.playerState === PLAYER_ENDED) {
      onEnded();
    } else if (data.event === 'onError') {
      showError(data.info);
    }
  }
  addEventListener('message', onMessage);
  ctx.onCleanup(() => {
    removeEventListener('message', onMessage);
    clearInterval(handshake);
  });

  function load(start = 0) {
    ready = false;
    clearInterval(handshake);
    el.innerHTML = `<iframe title="Video player" src="${esc(playerUrls(id, { start }).embed)}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
      allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    iframe = el.querySelector('iframe');
    // The embed only starts reporting events after a "listening" message;
    // repeat it until the player has booted (as YouTube's own script does).
    iframe.addEventListener('load', () => {
      let tries = 0;
      const ping = () => {
        if (ready || ++tries > 40) return clearInterval(handshake);
        iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), EMBED_ORIGIN);
      };
      ping();
      handshake = setInterval(ping, 250);
    });
  }

  function showError(code) {
    const blocked = EMBED_BLOCKED_ERRORS.has(Number(code));
    const message = blocked
      ? 'The uploader doesn’t allow this video to be played on other websites.'
      : Number(code) === 100
        ? 'This video is private or has been removed.'
        : `The player reported an error (code ${esc(code)}).`;
    const overlay = html(`
      <div class="player-error">
        ${icon('warning')}
        <p>${message}</p>
        <a class="btn" href="${esc(playerUrls(id).watch)}" target="_blank" rel="noopener noreferrer">${icon('external')}Watch on YouTube</a>
      </div>`);
    el.querySelector('.player-error')?.remove();
    el.append(overlay);
  }

  return {
    load,
    seek(seconds) {
      if (ready) {
        send('seekTo', [seconds, true]);
        send('playVideo');
      } else {
        load(seconds);
      }
    },
  };
}

// --- Details --------------------------------------------------------------------

function renderMeta(el, video, { partial = false } = {}) {
  const watch = playerUrls(video.id).watch;
  const channel = video.channel || {};
  const subs = subscribersLabel(channel);
  const views = video.viewCount != null ? `${fullNumber(video.viewCount)} ${video.isLive ? 'watching' : 'views'}` : viewsLabel(video);
  const date = video.dateText || publishedLabel(video);
  const tags = (video.keywords || []).slice(0, 3).map(k => `#${k.replace(/\s+/g, '')}`);

  el.innerHTML = `
    <h1 class="watch-title">${esc(video.title)}</h1>
    <div class="watch-row">
      <div class="owner">
        ${channel.id ? `<a href="/channel/${esc(channel.id)}" tabindex="-1">${avatar(channel, 40)}</a>` : avatar(channel, 40)}
        <div class="owner-text">
          ${channel.id ? `<a class="owner-name" href="/channel/${esc(channel.id)}">${esc(channel.name)}${channel.verified ? `<span class="verified">${icon('verified')}</span>` : ''}</a>` : `<span class="owner-name">${esc(channel.name || '')}</span>`}
          ${subs ? `<span class="owner-subs">${esc(subs)}</span>` : ''}
        </div>
        ${subscribeButton(channel)}
      </div>
      <div class="watch-actions">
        ${video.likes ? `<span class="pill" title="${fullNumber(video.likes)} likes">${icon('like')}${compact(video.likes)}</span>` : ''}
        <button type="button" class="pill" data-act="share">${icon('share')}Share</button>
        <a class="pill" href="${esc(watch)}" target="_blank" rel="noopener noreferrer" title="Open on YouTube">${icon('external')}<span class="pill-label">YouTube</span></a>
      </div>
    </div>
    <div class="description ${partial ? '' : 'collapsed'}">
      <div class="desc-head">
        ${views ? `<span>${esc(views)}</span>` : ''}
        ${date ? `<span title="${esc(video.publishedText || '')}">${esc(date)}</span>` : ''}
        ${tags.map(t => `<a href="/results?search_query=${encodeURIComponent(t)}">${esc(t)}</a>`).join(' ')}
      </div>
      ${partial ? '<div class="meta-skeleton"><span class="sk-line"></span><span class="sk-line short"></span></div>' : `
        <div class="desc-body">${linkify(video.description, { videoId: video.id }) || '<span class="muted">No description.</span>'}</div>
        <button type="button" class="desc-toggle">...more</button>`}
    </div>`;

  el.querySelector('[data-act="share"]').addEventListener('click', async () => {
    const link = `${location.origin}/watch?v=${video.id}`;
    toast((await copyText(link)) ? 'Link copied to clipboard' : link);
  });

  const box = el.querySelector('.description.collapsed');
  if (!box) return;
  const toggle = box.querySelector('.desc-toggle');
  const body = box.querySelector('.desc-body');
  // Hide "...more" when everything already fits.
  requestAnimationFrame(() => {
    if (body.scrollHeight <= body.clientHeight + 2) {
      box.classList.remove('collapsed');
      toggle.hidden = true;
    }
  });
  box.addEventListener('click', e => {
    if (e.target.closest('a') || !box.classList.contains('collapsed')) return;
    box.classList.remove('collapsed');
    toggle.textContent = 'Show less';
  });
  toggle.addEventListener('click', e => {
    if (box.classList.contains('collapsed')) return; // handled above
    e.stopPropagation();
    box.classList.add('collapsed');
    toggle.textContent = '...more';
    box.scrollIntoView({ block: 'nearest' });
  });
}

// Related videos: the first batch comes with the details; more load as the
// sidebar is scrolled, like YouTube's endless "up next" column.
function mountRelated(el, ctx, video) {
  el.innerHTML = '';
  delete ctx.state.related;
  return mountFeed(ctx, {
    list: el,
    layout: 'compact',
    stateKey: 'related',
    fetchPage: continuation => (continuation ? api('related', { continuation }) : Promise.resolve({ items: video.related, continuation: video.relatedContinuation })),
    filter: item => item.type === 'video' && item.id !== video.id,
    empty: '<p class="muted">No related videos.</p>',
  });
}

// When the details can't be loaded (and so no recommendations), fall back to
// a search for the video's title so the sidebar isn't empty.
async function relatedFallback(el, ctx, id, preview) {
  if (!preview?.title) {
    el.innerHTML = '';
    return;
  }
  try {
    const data = await api('search', { q: preview.title, type: 'videos' });
    if (!ctx.alive) return;
    const items = data.items.filter(v => v.type === 'video' && v.id !== id);
    rememberVideos(items);
    el.innerHTML = items.map(videoCompact).join('');
  } catch {
    if (ctx.alive) el.innerHTML = '';
  }
}

// --- Comments ----------------------------------------------------------------

function commentHtml(c, videoId) {
  const a = c.author;
  const name = `${esc(a.name)}${a.verified ? `<span class="verified">${icon('verified')}</span>` : ''}`;
  return `
    <div class="comment">
      ${a.id ? `<a href="/channel/${esc(a.id)}" tabindex="-1">${avatar(a, 40)}</a>` : avatar(a, 40)}
      <div class="comment-main">
        ${c.pinned ? `<div class="comment-pinned">${icon('pin')}Pinned</div>` : ''}
        <div class="comment-head">
          ${a.id ? `<a class="comment-author ${a.isOwner ? 'owner' : ''}" href="/channel/${esc(a.id)}">${name}</a>` : `<span class="comment-author">${name}</span>`}
          <span class="comment-time">${esc(c.publishedText)}${c.edited ? ' (edited)' : ''}</span>
        </div>
        <div class="comment-text clamp">${linkify(c.text, { videoId })}</div>
        <button type="button" class="link-btn read-more" hidden>Read more</button>
        <div class="comment-actions">
          <span class="comment-likes">${icon('like')}${c.likes ? compact(c.likes) : ''}</span>
          ${c.hearted ? `<span class="comment-heart" title="Hearted by the creator">${icon('heart')}</span>` : ''}
        </div>
        ${c.replyCount && c.repliesToken ? `
          <button type="button" class="replies-toggle" data-token="${esc(c.repliesToken)}">${icon('expand')}<span>${fullNumber(c.replyCount)} ${c.replyCount === 1 ? 'reply' : 'replies'}</span></button>
          <div class="replies" hidden></div>` : ''}
      </div>
    </div>`;
}

// Show "Read more" only on comments that are actually clamped. Measured in
// one batch per page to avoid layout thrashing.
function measureClamps(root) {
  requestAnimationFrame(() => {
    for (const text of root.querySelectorAll('.comment-text.clamp:not([data-measured])')) {
      text.dataset.measured = '1';
      if (text.scrollHeight > text.clientHeight + 2) text.nextElementSibling.hidden = false;
    }
  });
}

function mountComments(section, ctx, videoId) {
  let sort = 'top';
  let generation = 0;

  section.innerHTML = `
    <header class="comments-header">
      <h2 class="comments-count">Comments</h2>
      <label class="comments-sort" hidden>${icon('sort')}<span class="sr-only">Sort by</span>
        <select><option value="top">Top comments</option><option value="new">Newest first</option></select>
      </label>
    </header>
    <div class="comment-list"></div>`;

  const sortEl = section.querySelector('.comments-sort');
  const countEl = section.querySelector('.comments-count');

  function start() {
    const gen = ++generation;
    section.querySelector('.feed-footer')?.remove();
    const list = section.querySelector('.comment-list');
    list.innerHTML = '';
    delete ctx.state.comments;
    mountFeed(ctx, {
      list,
      stateKey: 'comments',
      isAlive: () => ctx.alive && gen === generation,
      skeleton: skeletons('compact', 4),
      fetchPage: continuation => api(`comments/${videoId}`, { sort, continuation }),
      renderItems: items => items.map(c => commentHtml(c, videoId)).join(''),
      onRendered: () => measureClamps(list),
      onFirstPage: page => {
        if (page.disabled) countEl.textContent = 'Comments are turned off';
        else if (page.countText) countEl.textContent = `${page.countText} Comments`;
        sortEl.hidden = !page.sortable;
      },
      empty: '<p class="muted">No comments to show.</p>',
    });
  }

  sortEl.querySelector('select').addEventListener('change', e => {
    sort = e.target.value;
    start();
  });

  section.addEventListener('click', async e => {
    const more = e.target.closest('.read-more');
    if (more) {
      const text = more.previousElementSibling;
      const expanded = text.classList.toggle('clamp') === false;
      more.textContent = expanded ? 'Show less' : 'Read more';
      return;
    }

    const toggle = e.target.closest('.replies-toggle, .more-replies');
    if (!toggle) return;
    const container = toggle.classList.contains('more-replies') ? toggle.parentElement : toggle.nextElementSibling;

    if (toggle.classList.contains('replies-toggle') && container.dataset.loaded) {
      container.hidden = !container.hidden;
      toggle.classList.toggle('open', !container.hidden);
      return;
    }

    toggle.disabled = true;
    container.hidden = false;
    toggle.classList.add('open');
    const spinnerEl = html('<div class="spinner small"></div>');
    container.append(spinnerEl);
    try {
      const data = await api(`comments/${videoId}`, { continuation: toggle.dataset.token });
      spinnerEl.remove();
      container.dataset.loaded = '1';
      container.insertAdjacentHTML('beforeend', data.items.map(c => commentHtml(c, videoId)).join(''));
      if (toggle.classList.contains('more-replies')) toggle.remove();
      if (data.continuation) {
        container.insertAdjacentHTML('beforeend', `<button type="button" class="more-replies link-btn" data-token="${esc(data.continuation)}">Show more replies</button>`);
      }
      measureClamps(container);
    } catch (err) {
      spinnerEl.remove();
      toast(`Couldn't load replies: ${err.message}`);
    } finally {
      toggle.disabled = false;
    }
  });

  start();
}
