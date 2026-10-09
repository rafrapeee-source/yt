// App shell: client-side router, masthead search with suggestions, guide
// (sidebar), settings dialog and instance health indicator.

import { $, esc, debounce, toast } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { api } from './api.js';
import { avatar } from './components.js';
import {
  getSettings, currentInstance, updateSettings, setInstance, instanceOptions,
  getSubscriptions, toggleSubscription, onChange,
} from './store.js';
import { homeView } from './views/home.js';
import { resultsView } from './views/results.js';
import { watchView } from './views/watch.js';
import { channelView } from './views/channel.js';
import { subscriptionsView, historyView } from './views/library.js';
import { notFoundView } from './views/notfound.js';

const app = $('#app');

// --- Router ------------------------------------------------------------------

const ROUTES = [
  { name: 'home', pattern: /^\/$/, view: homeView },
  { name: 'results', pattern: /^\/results$/, view: resultsView },
  { name: 'watch', pattern: /^\/watch$/, view: watchView },
  { name: 'channel', pattern: /^\/channel\/([\w-]+)\/?$/, view: channelView },
  { name: 'subscriptions', pattern: /^\/feed\/subscriptions$/, view: subscriptionsView },
  { name: 'history', pattern: /^\/feed\/history$/, view: historyView },
];

// Per-history-entry view state (loaded items, scroll position), so Back/Forward
// restores a page exactly instead of refetching and jumping to the top.
const pageStates = new Map();
let renderToken = 0;
let cleanups = [];

history.scrollRestoration = 'manual';

function entryKey() {
  if (!history.state?.key) history.replaceState({ key: crypto.randomUUID?.() || String(Math.random()) }, '');
  return history.state.key;
}

function saveScroll() {
  const state = pageStates.get(entryKey());
  if (state) state.scrollY = scrollY;
}

export function navigate(url, { replace = false } = {}) {
  saveScroll();
  const key = crypto.randomUUID?.() || String(Math.random());
  if (replace) history.replaceState({ key }, '', url);
  else history.pushState({ key }, '', url);
  render({ restoring: false });
}

async function render({ restoring }) {
  cleanups.forEach(fn => fn());
  cleanups = [];
  const token = ++renderToken;

  const url = new URL(location.href);
  const route = ROUTES.find(r => r.pattern.test(url.pathname));
  const key = entryKey();
  if (!pageStates.has(key)) pageStates.set(key, {});
  while (pageStates.size > 40) pageStates.delete(pageStates.keys().next().value);
  const state = pageStates.get(key);

  const ctx = {
    url,
    params: url.searchParams,
    match: route ? url.pathname.match(route.pattern) : null,
    state,
    get alive() {
      return token === renderToken;
    },
    onCleanup(fn) {
      cleanups.push(fn);
    },
  };

  document.body.dataset.page = route?.name || 'notfound';
  closeDrawer();
  updateGuideActive(route?.name);
  if (route?.name === 'results') $('#search-input').value = url.searchParams.get('search_query') || '';
  else if (route?.name !== 'watch') $('#search-input').value = '';

  app.innerHTML = '';
  if (!restoring) scrollTo(0, 0);

  try {
    await (route ? route.view : notFoundView)(app, ctx);
  } catch (err) {
    console.error(err);
  }
  if (restoring && ctx.alive && state.scrollY) scrollTo(0, state.scrollY);
}

addEventListener('popstate', () => render({ restoring: true }));
addEventListener('pagehide', saveScroll);

// Route same-origin link clicks through the router (keeps middle-click,
// ctrl/cmd-click and "open in new tab" working normally).
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/img') return;

  // Timestamps on the current video seek instead of reloading the page.
  if (a.dataset.seek && document.body.dataset.page === 'watch' && url.searchParams.get('v') === new URL(location.href).searchParams.get('v')) {
    e.preventDefault();
    document.dispatchEvent(new CustomEvent('findtube:seek', { detail: Number(a.dataset.seek) }));
    return;
  }
  e.preventDefault();
  if (url.href !== location.href) navigate(url.pathname + url.search);
});

// Subscribe buttons anywhere on the page.
document.addEventListener('click', e => {
  const btn = e.target.closest('button[data-sub-id]');
  if (!btn) return;
  const channel = { id: btn.dataset.subId, name: btn.dataset.subName, avatar: btn.dataset.subAvatar };
  const subscribed = toggleSubscription(channel);
  toast(subscribed ? `Subscribed to ${channel.name}` : `Unsubscribed from ${channel.name}`);
});

function syncSubscribeButtons() {
  const ids = new Set(getSubscriptions().map(s => s.id));
  for (const btn of document.querySelectorAll('button[data-sub-id]')) {
    const on = ids.has(btn.dataset.subId);
    btn.classList.toggle('subscribed', on);
    btn.textContent = on ? 'Subscribed' : 'Subscribe';
  }
}

// Broken images: hide them so the avatar initial / thumbnail placeholder shows.
document.addEventListener('error', e => {
  if (e.target instanceof HTMLImageElement) e.target.classList.add('broken');
}, true);

// --- Guide (sidebar) -----------------------------------------------------------

const drawerQuery = matchMedia('(max-width: 1100px)');
const isDrawerMode = () => drawerQuery.matches || document.body.dataset.page === 'watch';

function closeDrawer() {
  document.body.classList.remove('drawer-open');
  $('#scrim').hidden = true;
}

$('#guide-btn').addEventListener('click', () => {
  if (isDrawerMode()) {
    const open = !document.body.classList.contains('drawer-open');
    document.body.classList.toggle('drawer-open', open);
    $('#scrim').hidden = !open;
  } else {
    document.body.classList.toggle('guide-collapsed');
  }
});
$('#scrim').addEventListener('click', closeDrawer);

function updateGuideActive(name) {
  for (const a of document.querySelectorAll('.guide-item[data-route]')) a.classList.toggle('active', a.dataset.route === name);
}

function renderGuideSubs() {
  const subs = getSubscriptions();
  $('#guide-subs').innerHTML = subs.length
    ? subs.map(s => `<a href="/channel/${esc(s.id)}" class="guide-item">${avatar(s, 24)}<span>${esc(s.name)}</span></a>`).join('')
    : '<p class="guide-empty">Channels you subscribe to will show up here.</p>';
}

onChange('subscriptions', () => {
  renderGuideSubs();
  syncSubscribeButtons();
});

// --- Search box + suggestions --------------------------------------------------

const searchForm = $('#search-form');
const searchInput = $('#search-input');
const suggestBox = $('#suggestions');
let suggestions = [];
let activeSuggestion = -1;
let suggestToken = 0;

function submitSearch(query) {
  const q = query.trim();
  if (!q) return;
  hideSuggestions();
  searchInput.blur();
  document.body.classList.remove('mobile-search');
  const current = new URL(location.href);
  const params = new URLSearchParams({ search_query: q });
  // Keep the active filters when refining a search.
  if (current.pathname === '/results') for (const k of ['type', 'sort', 'date', 'duration']) if (current.searchParams.get(k)) params.set(k, current.searchParams.get(k));
  navigate(`/results?${params}`);
}

function hideSuggestions() {
  suggestBox.hidden = true;
  activeSuggestion = -1;
  searchInput.removeAttribute('aria-activedescendant');
}

function showSuggestions(list) {
  suggestions = list.slice(0, 10);
  activeSuggestion = -1;
  if (!suggestions.length || document.activeElement !== searchInput) return hideSuggestions();
  suggestBox.innerHTML = suggestions
    .map((s, i) => `<li role="option" id="sugg-${i}" data-index="${i}">${icon('search')}<span>${esc(s)}</span></li>`)
    .join('');
  suggestBox.hidden = false;
}

const fetchSuggestions = debounce(async q => {
  const token = ++suggestToken;
  try {
    const data = await api('suggestions', { q });
    if (token === suggestToken && searchInput.value.trim() === q) showSuggestions(data.suggestions || []);
  } catch {
    /* suggestions are best-effort */
  }
}, 150);

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  if (q.length < 2) {
    suggestToken++;
    return hideSuggestions();
  }
  fetchSuggestions(q);
});

searchInput.addEventListener('keydown', e => {
  if (suggestBox.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = suggestions.length;
    activeSuggestion = e.key === 'ArrowDown' ? (activeSuggestion + 1) % n : (activeSuggestion - 1 + n) % n;
    suggestBox.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === activeSuggestion));
    searchInput.value = suggestions[activeSuggestion];
    searchInput.setAttribute('aria-activedescendant', `sugg-${activeSuggestion}`);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

suggestBox.addEventListener('mousedown', e => {
  const li = e.target.closest('li[data-index]');
  if (!li) return;
  e.preventDefault();
  searchInput.value = suggestions[li.dataset.index];
  submitSearch(searchInput.value);
});

searchInput.addEventListener('blur', () => setTimeout(hideSuggestions, 100));
searchForm.addEventListener('submit', e => {
  e.preventDefault();
  submitSearch(searchInput.value);
});

$('#mobile-search-btn').addEventListener('click', () => {
  document.body.classList.add('mobile-search');
  searchInput.focus();
});
searchInput.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!searchInput.value && document.activeElement !== searchInput) document.body.classList.remove('mobile-search');
  }, 150);
});

// "/" focuses search, like YouTube.
document.addEventListener('keydown', e => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
  e.preventDefault();
  searchInput.focus();
  searchInput.select();
});

// --- Instance status + settings dialog -------------------------------------------

const dialog = $('#settings-dialog');
let checkToken = 0;

function setDot(el, status, title) {
  el.className = `status-dot ${status}`;
  if (title) el.title = title;
}

async function checkInstance() {
  const token = ++checkToken;
  const instance = currentInstance();
  const dots = [$('#status-dot'), $('#set-status-dot')];
  dots.forEach(d => setDot(d, 'checking', `Checking ${instance}…`));
  $('#set-status-text').textContent = `Checking ${instance}…`;
  $('#instance-pill-name').textContent = instance;

  try {
    const data = await fetch(`/api/check-instance?backend=${getSettings().backend}&instance=${encodeURIComponent(instance)}`).then(r => r.json());
    if (token !== checkToken) return;
    if (data.error) throw new Error(data.error);
    const msg = `${instance} is up (${(data.elapsedMs / 1000).toFixed(1)}s).`;
    dots.forEach(d => setDot(d, 'ok', msg));
    $('#set-status-text').textContent = msg + ' Individual pages can still fail if YouTube is rate-limiting it.';
  } catch (err) {
    if (token !== checkToken) return;
    const msg = err.message === 'Failed to fetch' ? 'Could not reach the Findtube server.' : err.message;
    dots.forEach(d => setDot(d, 'down', msg));
    $('#set-status-text').textContent = msg;
  }
}

function fillSettingsForm() {
  const s = getSettings();
  $('#set-backend').value = s.backend;
  $('#set-instance').innerHTML = instanceOptions().map(i => `<option value="${esc(i)}" ${i === currentInstance() ? 'selected' : ''}>${esc(i)}</option>`).join('');
  $('#set-player-host').value = s.playerHost[s.backend] || '';
  $('#set-proxy-video').checked = s.proxyVideo;
  $('#set-proxy-video').closest('.check').hidden = s.backend !== 'invidious';
  $('#set-autoplay').checked = s.autoplay;
  $('#set-autoplay-next').checked = s.autoplayNext;
  $('#set-player').value = s.player;
}

function openSettings() {
  fillSettingsForm();
  dialog.showModal();
}

$('#settings-btn').addEventListener('click', openSettings);
$('#instance-pill').addEventListener('click', openSettings);
dialog.addEventListener('click', e => {
  if (e.target === dialog) dialog.close(); // backdrop click
});

$('#set-backend').addEventListener('change', e => updateSettings({ backend: e.target.value }));
$('#set-instance').addEventListener('change', e => setInstance(e.target.value));
$('#set-custom-add').addEventListener('click', () => {
  const value = $('#set-custom').value.trim();
  if (!value) return;
  setInstance(value);
  $('#set-custom').value = '';
});
$('#set-custom').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#set-custom-add').click();
  }
});
$('#set-player-host').addEventListener('change', e => {
  const s = getSettings();
  updateSettings({ playerHost: { ...s.playerHost, [s.backend]: e.target.value.trim() } });
});
$('#set-proxy-video').addEventListener('change', e => updateSettings({ proxyVideo: e.target.checked }));
$('#set-autoplay').addEventListener('change', e => updateSettings({ autoplay: e.target.checked }));
$('#set-autoplay-next').addEventListener('change', e => updateSettings({ autoplayNext: e.target.checked }));
$('#set-player').addEventListener('change', e => updateSettings({ player: e.target.value }));

// Switching backend/instance changes every piece of data on screen, so
// re-check health and re-render the current page from the new source.
let lastSource = `${getSettings().backend}|${currentInstance()}`;
onChange('settings', () => {
  const source = `${getSettings().backend}|${currentInstance()}`;
  if (dialog.open) fillSettingsForm();
  if (source === lastSource) return;
  lastSource = source;
  pageStates.clear();
  checkInstance();
  toast(`Now using ${currentInstance()}`);
  render({ restoring: false });
});

// --- Boot ----------------------------------------------------------------------

hydrateIcons();
renderGuideSubs();
checkInstance();
render({ restoring: true });
