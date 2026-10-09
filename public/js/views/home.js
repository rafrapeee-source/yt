import { api } from '../api.js';
import { mountFeed, emptyState } from '../components.js';
import { esc, html } from '../util.js';
import { getHistory } from '../store.js';

const TOPICS = ['Music', 'Gaming', 'News', 'Live', 'Podcasts', 'Sports', 'Cooking', 'Science', 'Comedy', 'Programming', 'Travel'];

export async function homeView(root, ctx) {
  const topic = ctx.params.get('topic') || '';
  document.title = 'Findtube';

  root.append(
    html(`
    <div class="page page-wide">
      <div class="chips" role="tablist" aria-label="Topics">
        ${['', ...TOPICS]
          .map(t => `<a role="tab" class="chip ${t === topic ? 'active' : ''}" aria-selected="${t === topic}"
            href="${t ? `/?topic=${encodeURIComponent(t)}` : '/'}">${esc(t || 'All')}</a>`)
          .join('')}
      </div>
      <p class="feed-note" hidden></p>
      <div class="grid"></div>
    </div>`)
  );

  const note = root.querySelector('.feed-note');
  return mountFeed(ctx, {
    list: root.querySelector('.grid'),
    filter: item => item.type === 'video',
    fetchPage: topic
      ? continuation => api('search', { q: topic, type: 'videos', continuation })
      : continuation =>
          continuation
            ? api('search', { q: 'trending', continuation }) // later pages of the "popular" fallback
            : api('home', { seeds: getHistory().slice(0, 3).map(h => h.id).join(',') }),
    onFirstPage: page => {
      if (page.source === 'popular') {
        note.hidden = false;
        note.textContent = "Popular this week. Watch a few videos and this page will recommend more like them.";
      }
    },
    empty: emptyState('Nothing to show yet', 'Pick a topic above or search for something.'),
  });
}
