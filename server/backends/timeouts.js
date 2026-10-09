// Two very different kinds of upstream request:
// - quick lookups the instance answers itself (stats, suggestions);
// - anything that makes the instance query YouTube on our behalf (search,
//   video details, comments, channels), which can legitimately take a while
//   when YouTube is rate-limiting that instance. Too short a timeout there
//   makes a slow-but-working instance look broken.
module.exports = {
  FAST_TIMEOUT_MS: 8000,
  SLOW_TIMEOUT_MS: 25000,
};
