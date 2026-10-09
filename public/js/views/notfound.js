import { emptyState } from '../components.js';

export function notFoundView(root) {
  document.title = 'Not found - Findtube';
  root.innerHTML = `<div class="page">${emptyState('This page isn’t available', '<a href="/">Go to the home page</a>', 'warning')}</div>`;
}
