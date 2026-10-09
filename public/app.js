// Starter lists of known public instances per backend. Public instance
// availability changes often (see footer note), so these are convenience
// starting points, not guarantees — the "+ custom" button lets you point at
// any instance for the currently selected backend, including one your
// company or you self-host.
const KNOWN_INSTANCES = {
  invidious: ['yewtu.be', 'invidious.nerdvpn.de', 'inv.nadeko.net', 'invidious.tiekoetter.com'],
  piped: ['pipedapi.kavin.rocks', 'pipedapi.adminforge.de', 'piped-api.privacy.com.de'],
};

const STORAGE_KEY_INSTANCE = 'findtube.instance';
const STORAGE_KEY_BACKEND = 'findtube.backend';
const SEARCH_TIMEOUT_HINT_S = 25; // keep in sync with server SEARCH_TIMEOUT_MS

const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const playerSection = document.getElementById('player-section');
const playerFrameContainer = document.getElementById('player-frame-container');
const playerTitle = document.getElementById('player-title');
const playerSub = document.getElementById('player-sub');
const backendSelect = document.getElementById('backend-select');
const instanceSelect = document.getElementById('instance-select');
const instanceStatus = document.getElementById('instance-status');
const instanceCustomBtn = document.getElementById('instance-custom-btn');

let currentBackend = loadSaved(STORAGE_KEY_BACKEND) || 'invidious';
let currentInstance = loadSaved(STORAGE_KEY_INSTANCE + '.' + currentBackend) || KNOWN_INSTANCES[currentBackend][0];
let searchSlowTimer = null;

function loadSaved(key) {
  try {
    return window.localStorage ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function saveValue(key, value) {
  try {
    if (window.localStorage) localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function clearResults() {
  resultsEl.innerHTML = '';
}

// --- Backend + instance picker -------------------------------------------

function populateInstanceSelect() {
  instanceSelect.innerHTML = '';
  const known = KNOWN_INSTANCES[currentBackend];
  const list = known.includes(currentInstance) ? known : [currentInstance, ...known];

  for (const inst of list) {
    const opt = document.createElement('option');
    opt.value = inst;
    opt.textContent = inst;
    if (inst === currentInstance) opt.selected = true;
    instanceSelect.appendChild(opt);
  }
}

async function checkInstance(instance, backend) {
  instanceStatus.textContent = '●';
  instanceStatus.className = 'instance-status checking';
  instanceStatus.title = 'Checking instance…';

  try {
    const res = await fetch(
      `/api/check-instance?instance=${encodeURIComponent(instance)}&backend=${encodeURIComponent(backend)}`
    );
    const data = await res.json();
    // Ignore stale responses if the user switched backend/instance while this was in flight.
    if (backend !== currentBackend || instance !== currentInstance) return;

    if (data.ok) {
      instanceStatus.className = 'instance-status ok';
      const ms = data.elapsedMs ? ` (${(data.elapsedMs / 1000).toFixed(1)}s)` : '';
      instanceStatus.title =
        `${instance} is up${ms}. Note: this only checks the instance itself, ` +
        `not whether search will succeed — search can still be slow or blocked ` +
        `if YouTube is rate-limiting this instance in the background.`;
    } else {
      instanceStatus.className = 'instance-status down';
      instanceStatus.title = `${instance} is unreachable (${data.reason || 'unknown reason'})`;
    }
  } catch {
    if (backend !== currentBackend || instance !== currentInstance) return;
    instanceStatus.className = 'instance-status down';
    instanceStatus.title = `Could not reach the app server to check "${instance}"`;
  }
}

backendSelect.addEventListener('change', () => {
  currentBackend = backendSelect.value;
  saveValue(STORAGE_KEY_BACKEND, currentBackend);

  // Switch to that backend's last-used (or default) instance, since
  // instances aren't interchangeable between backends.
  currentInstance = loadSaved(STORAGE_KEY_INSTANCE + '.' + currentBackend) || KNOWN_INSTANCES[currentBackend][0];

  populateInstanceSelect();
  checkInstance(currentInstance, currentBackend);
});

instanceSelect.addEventListener('change', () => {
  currentInstance = instanceSelect.value;
  saveValue(STORAGE_KEY_INSTANCE + '.' + currentBackend, currentInstance);
  checkInstance(currentInstance, currentBackend);
});

instanceCustomBtn.addEventListener('click', () => {
  const entered = prompt(
    `Enter a ${currentBackend === 'piped' ? 'Piped' : 'Invidious'} instance domain or URL ` +
      `(e.g. ${KNOWN_INSTANCES[currentBackend][0]}, or your company\u2019s internal instance):`,
    currentInstance
  );
  if (!entered || !entered.trim()) return;

  const clean = entered.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  currentInstance = clean;
  saveValue(STORAGE_KEY_INSTANCE + '.' + currentBackend, currentInstance);
  populateInstanceSelect();
  checkInstance(currentInstance, currentBackend);
});

// --- Results rendering -------------------------------------------------

function renderResults(items, elapsedMs) {
  clearResults();

  const timing = elapsedMs ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';

  if (!items.length) {
    setStatus(`No results found${timing}. Try a different search, a different instance, or switch backend.`);
    return;
  }

  setStatus(`${items.length} result${items.length === 1 ? '' : 's'} found on ${currentInstance}${timing}.`);

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');

    card.innerHTML = `
      <div class="thumb-wrap">
        ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" />` : ''}
        <span class="duration-badge">${escapeHtml(item.durationText || '')}</span>
      </div>
      <div class="card-body">
        <div class="card-text">
          <p class="card-title">${escapeHtml(item.title)}</p>
          <p class="card-channel">${escapeHtml(item.channelTitle)}</p>
          <p class="card-meta">${escapeHtml([item.viewCountText, item.publishedText].filter(Boolean).join(' · '))}</p>
        </div>
      </div>
    `;

    const play = () => playVideo(item);
    card.addEventListener('click', play);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        play();
      }
    });

    resultsEl.appendChild(card);
  }
}

function buildPlaybackUrls(videoId) {
  if (currentBackend === 'piped') {
    // Piped instances' API host (pipedapi.*) is separate from their
    // frontend/watch-page host, which typically drops the "api" segment
    // (e.g. pipedapi.kavin.rocks -> piped.kavin.rocks). This holds for the
    // common public instances but isn't guaranteed for every custom one.
    const frontendHost = currentInstance.replace(/^pipedapi\./, 'piped.').replace(/^api\./, '');
    const watchUrl = `https://${frontendHost}/watch?v=${encodeURIComponent(videoId)}`;
    return { embedUrl: watchUrl, watchUrl, frontendHost };
  }

  // Invidious instances serve their own /embed/ route directly.
  const embedUrl = `https://${currentInstance}/embed/${encodeURIComponent(videoId)}?autoplay=1`;
  const watchUrl = `https://${currentInstance}/watch?v=${encodeURIComponent(videoId)}`;
  return { embedUrl, watchUrl, frontendHost: currentInstance };
}

function playVideo(item) {
  const { embedUrl, watchUrl, frontendHost } = buildPlaybackUrls(item.videoId);

  playerFrameContainer.innerHTML = `
    <iframe
      src="${embedUrl}"
      title="${escapeHtml(item.title)}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen
    ></iframe>
  `;

  playerTitle.textContent = item.title;
  playerSub.innerHTML = `${escapeHtml([item.channelTitle, item.viewCountText, item.publishedText].filter(Boolean).join(' · '))}
    &nbsp;·&nbsp; <a href="${watchUrl}" target="_blank" rel="noopener noreferrer">Open on ${escapeHtml(frontendHost)}</a>`;

  playerSection.classList.remove('hidden');
  playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- Search --------------------------------------------------------------

async function runSearch(query) {
  searchBtn.disabled = true;
  setStatus(`Searching “${query}” on ${currentInstance} (${currentBackend})…`);
  clearResults();

  clearTimeout(searchSlowTimer);
  searchSlowTimer = setTimeout(() => {
    setStatus(
      `Still searching “${query}” on ${currentInstance}… this instance is slow to respond right now ` +
      `(can take up to ${SEARCH_TIMEOUT_HINT_S}s). Hang tight, or try a different instance/backend.`
    );
  }, 4000);

  const searchedBackend = currentBackend;
  const searchedInstance = currentInstance;

  try {
    const res = await fetch(
      `/api/search?q=${encodeURIComponent(query)}&instance=${encodeURIComponent(searchedInstance)}&backend=${encodeURIComponent(searchedBackend)}`
    );
    const data = await res.json();
    clearTimeout(searchSlowTimer);

    // If the user switched backend/instance while this request was in
    // flight, don't show a stale result under the new selection.
    if (searchedBackend !== currentBackend || searchedInstance !== currentInstance) return;

    if (!res.ok) {
      setStatus(data.error || 'Something went wrong.', true);
      return;
    }

    renderResults(data.results, data.elapsedMs);
  } catch (err) {
    clearTimeout(searchSlowTimer);
    if (searchedBackend !== currentBackend || searchedInstance !== currentInstance) return;
    setStatus('Network error while searching. Is the app server running?', true);
  } finally {
    searchBtn.disabled = false;
  }
}

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;
  runSearch(query);
});

// --- Init --------------------------------------------------------------

backendSelect.value = currentBackend;
populateInstanceSelect();
checkInstance(currentInstance, currentBackend);
