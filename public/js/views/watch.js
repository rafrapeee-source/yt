import { api, peekVideo, playerUrls, rememberVideos } from '../api.js';
import { avatar, subscribeButton, videoCompact, skeletons, errorPanel, mountFeed, emptyState } from '../components.js';
import { addToHistory, getSettings, updateSettings } from '../store.js';
import { esc, html, linkify, compact, fullNumber, formatDate, timeAgo, parseTimestamp, subscribersLabel, viewsLabel, publishedLabel, copyText, toast, whenNearViewport } from '../util.js';
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
      <div class="player-wrap">
        <div class="player"></div>
        <div class="player-bar"></div>
      </div>
      <div class="watch-meta"></div>
      <aside class="watch-related" aria-label="Related videos"><div class="related-list">${skeletons('compact', 8)}</div></aside>
      <section class="comments" aria-label="Comments"></section>
    </div>`)
  );

  const metaEl = root.querySelector('.watch-meta');
  const relatedEl = root.querySelector('.related-list');
  const commentsEl = root.querySelector('.comments');
  const player = createPlayer(root.querySelector('.player'), root.querySelector('.player-bar'), id, ctx);
  const start = parseTimestamp(ctx.params.get('t'));

  // With the embed preference the player doesn't need the details, so it
  // starts loading right away; the built-in player waits for stream URLs.
  if (getSettings().player === 'embed') player.mountEmbed(start);
  else player.showLoading();

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
      document.title = `${video.title} - Findtube`;
      player.setDetails(video, start);
      renderMeta(metaEl, video);
      renderRelated(relatedEl, video.related);
      addToHistory(video);
    } catch (err) {
      if (!ctx.alive) return;
      player.setDetails(null, start);
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
// Two ways to play:
//  - built-in: a plain <video> fed with the muxed stream URLs the instance
//    hands out (usually 360p). Works even when the instance's web pages sit
//    behind an anti-bot check, and supports precise seeking and autoplay-next.
//  - embed: the instance's own player in an iframe (can do HD, but breaks if
//    the instance's site is blocked or challenge-protected).
// The "auto" setting prefers built-in when streams exist and falls back to
// the embed if the streams fail to load.

function createPlayer(el, bar, id, ctx) {
  let mode = null;
  let video = null;
  let details = null;
  let streams = [];
  let streamIndex = 0;

  function renderBar() {
    let quality = '';
    if (mode === 'native' && streams.length > 1) {
      quality = `<label class="player-quality">Quality <select>${streams
        .map((s, i) => `<option value="${i}" ${i === streamIndex ? 'selected' : ''}>${esc(s.quality || s.mime)}</option>`)
        .join('')}</select></label>`;
    } else if (mode === 'native') {
      quality = `<span class="muted">${esc(streams[streamIndex]?.quality || '')}</span>`;
    }
    const label = mode === 'native' ? 'Built-in player' : `Player from ${esc(playerUrls(id).host)}`;
    let switchBtn = '';
    if (mode === 'native') switchBtn = '<button type="button" class="link-btn" data-player="embed">Use the instance’s player (HD)</button>';
    else if (streams.length) switchBtn = '<button type="button" class="link-btn" data-player="native">Not playing? Use the built-in player</button>';

    bar.innerHTML = `<span class="player-label">${label}</span>${quality}<span class="spacer"></span>${switchBtn}`;
    bar.querySelector('select')?.addEventListener('change', e => {
      const t = currentTime();
      streamIndex = Number(e.target.value);
      mountNative(t);
    });
  }

  bar.addEventListener('click', e => {
    const target = e.target.closest('[data-player]')?.dataset.player;
    if (!target) return;
    const t = currentTime();
    updateSettings({ player: target === 'embed' ? 'embed' : 'auto' });
    if (target === 'embed') mountEmbed(t);
    else mountNative(t);
  });

  function currentTime() {
    return mode === 'native' && video ? Math.floor(video.currentTime) : 0;
  }

  function showLoading() {
    el.innerHTML = '<div class="player-loading"><div class="spinner"></div></div>';
  }

  function mountEmbed(start = 0) {
    mode = 'embed';
    video = null;
    el.innerHTML = `<iframe title="Video player" src="${esc(playerUrls(id, { start }).embed)}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
      allowfullscreen referrerpolicy="no-referrer"></iframe>`;
    renderBar();
  }

  function mountNative(start = 0) {
    const stream = streams[streamIndex];
    if (!stream) return mountEmbed(start);
    mode = 'native';
    el.innerHTML = '';
    video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.autoplay = getSettings().autoplay;
    if (details?.thumbnail) video.poster = details.thumbnail;
    video.src = stream.url + (start > 0 ? `#t=${start}` : '');

    video.addEventListener('error', () => {
      if (!ctx.alive || mode !== 'native') return;
      // Try the next stream before giving up on the built-in player.
      if (streamIndex < streams.length - 1) {
        streamIndex++;
        return mountNative(start);
      }
      toast('The built-in player couldn’t load this video, so the instance’s player is used instead.');
      mountEmbed(start);
    });

    video.addEventListener('ended', () => {
      const next = details?.related?.[0];
      if (!ctx.alive || !next || !getSettings().autoplayNext) return;
      toast(`Up next: ${next.title}`);
      navigate(`/watch?v=${next.id}`);
    });

    el.append(video);
    if (video.autoplay) video.play().catch(() => { /* autoplay blocked: the user presses play */ });
    renderBar();
  }

  return {
    showLoading,
    mountEmbed,
    setDetails(v, start) {
      details = v;
      streams = v?.streams || [];
      streamIndex = 0;
      if (mode === 'embed') return renderBar(); // already playing; just offer the switch
      if (getSettings().player !== 'embed' && streams.length) mountNative(start);
      else mountEmbed(start);
    },
    seek(seconds) {
      if (mode === 'native' && video) {
        video.currentTime = seconds;
        video.play().catch(() => {});
      } else {
        mountEmbed(seconds);
      }
    },
  };
}

function renderMeta(el, video, { partial = false } = {}) {
  const { host, watch } = playerUrls(video.id);
  const channel = video.channel || {};
  const subs = subscribersLabel(channel);
  const published = video.published ? `${formatDate(video.published)}` : publishedLabel(video);
  const views = video.views != null ? `${fullNumber(video.views)} ${video.isLive ? 'watching' : 'views'}` : viewsLabel(video);
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
        <a class="pill" href="${esc(watch)}" target="_blank" rel="noopener noreferrer" title="Open on ${esc(host)}">${icon('external')}<span class="pill-label">${esc(host)}</span></a>
      </div>
    </div>
    <div class="description ${partial ? '' : 'collapsed'}">
      <div class="desc-head">
        ${views ? `<span>${esc(views)}</span>` : ''}
        ${published ? `<span title="${esc(timeAgo(video.published))}">${esc(published)}</span>` : ''}
        ${tags.map(t => `<a href="/results?search_query=${encodeURIComponent(t)}">${esc(t)}</a>`).join(' ')}
      </div>
      ${partial ? '<div class="meta-skeleton"><span class="sk-line"></span><span class="sk-line short"></span></div>' : `
        <div class="desc-body">${linkify(video.description, { videoId: video.id }) || '<span class="muted">No description.</span>'}</div>
        ${video.category ? `<p class="desc-extra">Category: ${esc(video.category)}</p>` : ''}
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
    if (body.scrollHeight <= body.clientHeight + 2 && !box.querySelector('.desc-extra')) {
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

function renderRelated(el, items) {
  rememberVideos(items);
  el.innerHTML = items.length ? items.map(videoCompact).join('') : '<p class="muted">No related videos.</p>';
}

// When the instance can't provide details (and so no recommendations), fall
// back to a search for the video's title so the sidebar isn't empty.
async function relatedFallback(el, ctx, id, preview) {
  if (!preview?.title) {
    el.innerHTML = '';
    return;
  }
  try {
    const data = await api('search', { q: preview.title, type: 'videos' });
    if (!ctx.alive) return;
    renderRelated(el, data.items.filter(v => v.type === 'video' && v.id !== id));
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
        else if (page.count != null) countEl.textContent = `${fullNumber(page.count)} Comments`;
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

