// Pages built from data kept in this browser: the subscriptions feed and
// watch history.

import { api, rememberVideos } from '../api.js';
import { avatar, videoCard, videoRow, emptyState, skeletons } from '../components.js';
import { getSubscriptions, getHistory, removeFromHistory, clearHistory } from '../store.js';
import { esc, html, timeAgo, relativeToMs } from '../util.js';
import { icon } from '../icons.js';

const MAX_CHANNELS = 40;
const CONCURRENCY = 4;
const PER_CHANNEL = 12;

export async function subscriptionsView(root, ctx) {
  document.title = 'Subscriptions - Findtube';
  const subs = getSubscriptions();

  if (!subs.length) {
    root.innerHTML = `<div class="page">${emptyState(
      'No subscriptions yet',
      'Hit <strong>Subscribe</strong> on any channel and its latest videos will show up here. Subscriptions are stored only in this browser.',
      'subscriptions'
    )}</div>`;
    return;
  }

  root.append(
    html(`
    <div class="page page-wide">
      <div class="sub-channels">
        ${subs.map(s => `<a href="/channel/${esc(s.id)}" class="sub-channel">${avatar(s, 64)}<span>${esc(s.name)}</span></a>`).join('')}
      </div>
      <div class="section-head"><h2>Latest</h2><span class="feed-progress muted"></span></div>
      <div class="grid">${skeletons('grid', 8)}</div>
    </div>`)
  );

  const grid = root.querySelector('.grid');
  const progress = root.querySelector('.feed-progress');

  const render = () => {
    const videos = ctx.state.videos;
    rememberVideos(videos);
    grid.innerHTML = videos.length ? videos.map(videoCard).join('') : skeletons('grid', 8);
  };

  if (ctx.state.done) {
    render();
    progress.textContent = ctx.state.note || '';
    return;
  }

  // Fetch each channel's latest uploads a few at a time and merge them
  // newest-first as they arrive.
  ctx.state.videos = [];
  const queue = subs.slice(0, MAX_CHANNELS);
  let loaded = 0;
  let failed = 0;
  let empty = 0;
  const total = queue.length;

  const worker = async () => {
    while (queue.length && ctx.alive) {
      const sub = queue.shift();
      try {
        const page = await api(`channel/${sub.id}/videos`, { name: sub.name, avatar: sub.avatar });
        const items = page.items.filter(v => v.type === 'video').slice(0, PER_CHANNEL);
        if (!items.length) empty++;
        ctx.state.videos.push(...items);
        ctx.state.videos.sort((a, b) => relativeToMs(b.publishedText) - relativeToMs(a.publishedText));
      } catch {
        failed++;
      }
      loaded++;
      if (!ctx.alive) return;
      progress.textContent = loaded < total ? `Loading channels… ${loaded}/${total}` : summary(failed, empty);
      ctx.state.note = progress.textContent;
      render();
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  if (!ctx.alive) return;
  ctx.state.done = true;
  if (!ctx.state.videos.length) grid.innerHTML = emptyState('No videos found', 'None of your channels could be loaded right now. Try again in a moment.', 'warning');
}

// Explains gaps in the feed.
function summary(failed, empty) {
  const parts = [];
  if (failed) parts.push(`${failed} channel${failed === 1 ? '' : 's'} couldn't be loaded`);
  if (empty) parts.push(`${empty} have no videos`);
  return parts.length ? parts.join(', ') + '.' : '';
}

export async function historyView(root, ctx) {
  document.title = 'History - Findtube';

  const draw = () => {
    const entries = getHistory();
    root.innerHTML = '';
    if (!entries.length) {
      root.innerHTML = `<div class="page">${emptyState('No watch history', 'Videos you watch will be listed here. History is stored only in this browser.', 'history')}</div>`;
      return;
    }
    const page = html(`
      <div class="page page-narrow">
        <div class="section-head">
          <h1>Watch history</h1>
          <button type="button" class="btn ghost" data-act="clear">${icon('delete')}Clear all</button>
        </div>
        <div class="results-list">
          ${entries
            .map(e => `<div class="history-item">${videoRow({ ...e, type: 'video', publishedText: `Watched ${timeAgo(e.watchedAt)}` })}
              <button type="button" class="icon-btn" data-remove="${esc(e.id)}" aria-label="Remove from history" title="Remove from history">${icon('close')}</button></div>`)
            .join('')}
        </div>
      </div>`);
    root.append(page);
  };

  const onClick = e => {
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      removeFromHistory(remove.dataset.remove);
      remove.closest('.history-item').remove();
      if (!getHistory().length) draw();
    } else if (e.target.closest('[data-act="clear"]') && confirm('Clear all watch history?')) {
      clearHistory();
      draw();
    }
  };
  // #app outlives this view, so detach the listener when navigating away.
  root.addEventListener('click', onClick);
  ctx.onCleanup(() => root.removeEventListener('click', onClick));

  draw();
  rememberVideos(getHistory().map(e => ({ ...e, type: 'video' })));
}

