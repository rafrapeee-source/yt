import { api } from '../api.js';
import { mountFeed, emptyState } from '../components.js';
import { esc, html } from '../util.js';

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
      : () => api('trending'),
    onFirstPage: page => {
      if (page.source === 'popular') {
        note.hidden = false;
        note.textContent = "Trending isn't available on this instance, so this shows what's popular among its viewers.";
      }
    },
    empty: emptyState('Nothing trending right now', 'Pick a topic above or search for something.'),
  });
}
