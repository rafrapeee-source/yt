import { api } from '../api.js';
import { avatar, subscribeButton, mountFeed, errorPanel, emptyState } from '../components.js';
import { esc, html, linkify, plural, fullNumber, formatDate, subscribersLabel } from '../util.js';
import { icon } from '../icons.js';

export async function channelView(root, ctx) {
  const id = ctx.match[1];
  const tab = ctx.params.get('tab') === 'about' ? 'about' : 'videos';

  root.append(
    html(`
    <div class="page page-wide channel-page">
      <div class="channel-head">
        <div class="channel-header skeleton">
          <span class="sk-circle big"></span>
          <div><span class="sk-line"></span><span class="sk-line short"></span></div>
        </div>
      </div>
      <nav class="tabs" aria-label="Channel sections">
        <a href="/channel/${esc(id)}" class="tab ${tab === 'videos' ? 'active' : ''}">Videos</a>
        <a href="/channel/${esc(id)}?tab=about" class="tab ${tab === 'about' ? 'active' : ''}">About</a>
      </nav>
      <div class="tab-content"></div>
    </div>`)
  );

  const head = root.querySelector('.channel-head');
  const content = root.querySelector('.tab-content');

  let channel;
  try {
    channel = await api(`channel/${id}`);
  } catch (err) {
    if (!ctx.alive) return;
    head.innerHTML = '';
    head.append(errorPanel(err, { onRetry: () => { root.innerHTML = ''; channelView(root, ctx); } }));
    return;
  }
  if (!ctx.alive) return;

  document.title = `${channel.name} - Findtube`;
  renderHeader(head, channel, id);

  if (tab === 'about') {
    renderAbout(content, channel);
    return;
  }

  content.innerHTML = `${channel.videos.source === 'search'
    ? '<p class="feed-note">This instance couldn’t list the channel’s uploads, so these are search results from this channel.</p>'
    : ''}<div class="grid"></div>`;

  return mountFeed(ctx, {
    list: content.querySelector('.grid'),
    filter: item => item.type === 'video',
    fetchPage: continuation =>
      continuation
        ? api(`channel/${id}/videos`, { continuation, name: channel.name, avatar: channel.avatar })
        : Promise.resolve(channel.videos),
    empty: emptyState('No videos', 'This channel has no public videos, or the instance couldn’t load them.', 'subscriptions'),
  });
}

function renderHeader(el, channel, id) {
  const facts = [subscribersLabel(channel)].filter(Boolean).map(esc);
  el.innerHTML = `
    ${channel.banner ? `<div class="channel-banner"><img src="${esc(channel.banner)}" alt="" decoding="async" /></div>` : ''}
    <header class="channel-header">
      ${avatar(channel, 160)}
      <div class="channel-info">
        <h1>${esc(channel.name)}${channel.verified ? `<span class="verified">${icon('verified')}</span>` : ''}</h1>
        <div class="vmeta">${facts.join('<span class="dot">•</span>')}</div>
        ${channel.description ? `<a class="channel-desc" href="/channel/${esc(id)}?tab=about">${esc(channel.description.split('\n')[0])}</a>` : ''}
        ${subscribeButton({ id: channel.id || id, name: channel.name, avatar: channel.avatar })}
      </div>
    </header>`;
}

function renderAbout(el, channel) {
  const stats = [
    channel.subscribers != null ? plural(channel.subscribers, 'subscriber') : '',
    channel.totalViews ? `${fullNumber(channel.totalViews)} views` : '',
    channel.joined ? `Joined ${formatDate(channel.joined)}` : '',
  ].filter(Boolean);

  el.innerHTML = `
    <div class="about">
      <section>
        <h2>Description</h2>
        <div class="about-desc">${linkify(channel.description) || '<span class="muted">No description.</span>'}</div>
      </section>
      ${stats.length ? `<section><h2>Stats</h2><ul class="about-stats">${stats.map(s => `<li>${esc(s)}</li>`).join('')}</ul></section>` : ''}
      ${channel.tags?.length ? `<section><h2>Tags</h2><div class="chips wrap">${channel.tags.map(t => `<a class="chip" href="/results?search_query=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div></section>` : ''}
    </div>`;
}
