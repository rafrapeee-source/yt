import { api } from '../api.js';
import { mountFeed, emptyState } from '../components.js';
import { getSettings } from '../store.js';
import { esc, html } from '../util.js';
import { icon } from '../icons.js';
import { navigate } from '../main.js';

const TYPES = [['', 'All'], ['videos', 'Videos'], ['channels', 'Channels']];

// Extra filters only Invidious supports.
const FILTERS = {
  sort: ['Sort by', [['', 'Relevance'], ['upload_date', 'Upload date'], ['view_count', 'View count'], ['rating', 'Rating']]],
  date: ['Upload date', [['', 'Any time'], ['hour', 'Last hour'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year']]],
  duration: ['Duration', [['', 'Any'], ['short', 'Under 4 minutes'], ['long', 'Over 20 minutes']]],
};

export async function resultsView(root, ctx) {
  const q = (ctx.params.get('search_query') || '').trim();
  if (!q) return navigate('/', { replace: true });
  document.title = `${q} - Findtube`;

  const current = Object.fromEntries(['type', 'sort', 'date', 'duration'].map(k => [k, ctx.params.get(k) || '']));
  const hasFilters = getSettings().backend === 'invidious';
  const activeFilterCount = ['sort', 'date', 'duration'].filter(k => current[k]).length;

  const hrefWith = patch => {
    const params = new URLSearchParams({ search_query: q });
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) params.set(k, v);
    return `/results?${params}`;
  };

  root.append(
    html(`
    <div class="page page-narrow">
      <div class="results-toolbar">
        <div class="chips">
          ${TYPES.map(([v, label]) => `<a class="chip ${current.type === v ? 'active' : ''}" href="${esc(hrefWith({ type: v }))}">${label}</a>`).join('')}
        </div>
        ${hasFilters ? `<button type="button" class="btn ghost filters-btn" aria-expanded="${activeFilterCount > 0}">${icon('sort')}Filters${activeFilterCount ? ` (${activeFilterCount})` : ''}</button>` : ''}
      </div>
      ${
        hasFilters
          ? `<div class="filters" ${activeFilterCount ? '' : 'hidden'}>
          ${Object.entries(FILTERS)
            .map(
              ([key, [title, options]]) => `
            <div class="filter-group">
              <h4>${title}</h4>
              ${options.map(([v, label]) => `<a class="filter-option ${current[key] === v ? 'active' : ''}" href="${esc(hrefWith({ [key]: v }))}">${label}</a>`).join('')}
            </div>`
            )
            .join('')}
        </div>`
          : ''
      }
      <div class="results-list"></div>
    </div>`)
  );

  root.querySelector('.filters-btn')?.addEventListener('click', e => {
    const panel = root.querySelector('.filters');
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
  });

  return mountFeed(ctx, {
    list: root.querySelector('.results-list'),
    layout: 'row',
    fetchPage: continuation => api('search', { q, ...current, continuation }),
    empty: emptyState('No results found', 'Try different keywords, remove filters, or switch instance.'),
  });
}
