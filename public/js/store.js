// Everything persisted in this browser: settings, subscriptions, watch history.
// Storage can be unavailable (private windows, blocked site data), so every
// access is wrapped and the app keeps working in memory.

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

const events = new EventTarget();
export const onChange = (type, fn) => events.addEventListener(type, fn);
const emit = type => events.dispatchEvent(new Event(type));

// --- Settings --------------------------------------------------------------

const DEFAULT_SETTINGS = {
  autoplay: true,
  autoplayNext: true,
};

function pick(obj, keys) {
  return Object.fromEntries(keys.filter(k => obj && k in obj).map(k => [k, obj[k]]));
}

// Ignores keys left over from older versions (instance settings).
let settings = { ...DEFAULT_SETTINGS, ...pick(read(KEYS.settings, {}), Object.keys(DEFAULT_SETTINGS)) };

export function getSettings() {
  return settings;
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  write(KEYS.settings, settings);
  emit('settings');
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
