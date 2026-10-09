// Light/dark theme. Loaded as a plain blocking script in <head> so the saved
// theme is applied before the first paint — no flash of the wrong colors.
// The app's modules use window.findtubeTheme to read and change it.
(function () {
  var KEY = 'findtube.theme';
  var root = document.documentElement;
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function preference() {
    try {
      var saved = localStorage.getItem(KEY);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch (e) {
      return 'system';
    }
  }

  // "system" resolves to whatever the OS currently uses.
  function resolve(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return darkQuery.matches ? 'dark' : 'light';
  }

  function apply() {
    var theme = resolve(preference());
    root.setAttribute('data-theme', theme);
    document.dispatchEvent(new CustomEvent('findtube:theme', { detail: { theme: theme, preference: preference() } }));
  }

  function set(pref) {
    try {
      if (pref === 'light' || pref === 'dark') localStorage.setItem(KEY, pref);
      else localStorage.removeItem(KEY);
    } catch (e) {
      /* storage unavailable: the choice lasts until reload */
      root.setAttribute('data-theme', resolve(pref));
      return;
    }
    apply();
  }

  // Follow OS changes while the preference is "system".
  darkQuery.addEventListener('change', function () {
    if (preference() === 'system') apply();
  });

  window.findtubeTheme = {
    preference: preference,
    current: function () {
      return root.getAttribute('data-theme');
    },
    set: set,
    toggle: function () {
      set(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    },
  };

  apply();
})();
