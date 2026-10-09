// Everything persisted in this browser: settings, subscriptions, watch history.
// Storage can be unavailable (private windows, blocked site data), so every
// access is wrapped and the app keeps working in memory.

// Starter lists of public instances. Availability changes constantly (YouTube
// rate-limits and blocks them); the settings dialog accepts any other address,
// including a company-run or self-hosted instance.
export const KNOWN_INSTANCES = {
  invidious: ['invidious.f5.si', 'yewtu.be', 'inv.nadeko.net', 'invidious.nerdvpn.de', 'invidious.tiekoetter.com'],
  piped: ['api.piped.private.coffee', 'pipedapi.kavin.rocks', 'pipedapi.adminforge.de'],
};

const KEYS = {
  settings: 'findtube.settings',
  subscriptions: 'findtube.subscriptions',
  history: 'findtube.history',
};
const MAX_HISTORY = 200;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable — keep going in memory */
  }
}

function legacy(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const events = new EventTarget();
export const onChange = (type, fn) => events.addEventListener(type, fn);
const emit = type => events.dispatchEvent(new Event(type));

// --- Settings --------------------------------------------------------------

function loadSettings() {
  const saved = read(KEYS.settings, null);
  if (saved) return { ...defaults(), ...saved, instances: { ...defaults().instances, ...saved.instances } };
  // Migrate from the previous version's separate keys.
  const backend = legacy('findtube.backend') === 'piped' ? 'piped' : 'invidious';
  const s = defaults();
  s.backend = backend;
  for (const b of ['invidious', 'piped']) {
    const inst = legacy('findtube.instance.' + b);
    if (inst) s.instances[b] = inst;
  }
  return s;
}

function defaults() {
  return {
    backend: 'invidious',
    instances: { invidious: KNOWN_INSTANCES.invidious[0], piped: KNOWN_INSTANCES.piped[0] },
    customInstances: { invidious: [], piped: [] },
    playerHost: { invidious: '', piped: '' },
    player: 'auto', // 'auto' = built-in <video> when the instance offers streams, else embed
    proxyVideo: false,
    autoplay: true,
    autoplayNext: true,
  };
}

let settings = loadSettings();

export function getSettings() {
  return settings;
}

export function currentInstance() {
  return settings.instances[settings.backend];
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  write(KEYS.settings, settings);
  emit('settings');
}

export function setInstance(instance, backend = settings.backend) {
  const clean = instance.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!clean) return;
  const custom = { ...settings.customInstances };
  if (!KNOWN_INSTANCES[backend].includes(clean) && !custom[backend].includes(clean)) {
    custom[backend] = [clean, ...custom[backend]].slice(0, 8);
  }
  updateSettings({ backend, instances: { ...settings.instances, [backend]: clean }, customInstances: custom });
}

export function instanceOptions(backend = settings.backend) {
  return [...new Set([settings.instances[backend], ...settings.customInstances[backend], ...KNOWN_INSTANCES[backend]])];
}

export function nextInstance() {
  const list = instanceOptions();
  return list[(list.indexOf(currentInstance()) + 1) % list.length];
}

// --- Subscriptions ---------------------------------------------------------

let subscriptions = read(KEYS.subscriptions, []);

export const getSubscriptions = () => subscriptions;
export const isSubscribed = id => subscriptions.some(s => s.id === id);

export function toggleSubscription(channel) {
  if (isSubscribed(channel.id)) {
    subscriptions = subscriptions.filter(s => s.id !== channel.id);
  } else {
    const { id, name, avatar } = channel;
    subscriptions = [...subscriptions, { id, name, avatar }].sort((a, b) => a.name.localeCompare(b.name));
  }
  write(KEYS.subscriptions, subscriptions);
  emit('subscriptions');
  return isSubscribed(channel.id);
}

// --- Watch history ---------------------------------------------------------

let history = read(KEYS.history, []);

export const getHistory = () => history;

export function addToHistory(video) {
  const { id, title, thumbnail, duration, isLive, channel } = video;
  const entry = { id, title, thumbnail, duration, isLive, channel: { id: channel?.id, name: channel?.name }, watchedAt: Date.now() };
  history = [entry, ...history.filter(h => h.id !== id)].slice(0, MAX_HISTORY);
  write(KEYS.history, history);
}

export function removeFromHistory(id) {
  history = history.filter(h => h.id !== id);
  write(KEYS.history, history);
}

export function clearHistory() {
  history = [];
  write(KEYS.history, history);
}
