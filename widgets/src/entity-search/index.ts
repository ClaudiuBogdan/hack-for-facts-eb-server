/**
 * Entity-search widget — renders `search_entities` results as the client's
 * entity palette does: type badge, title, subtitle, CUI, county, inactive chip.
 */

import { SITE_BASE, hitHref } from './hit-link.js';
import { renderRow, type SearchHitView } from './row.js';
import { bootstrapWidget, type ToolEnvelope, type WidgetHandle } from '../lib/bootstrap.js';
import { esc, formatNumber } from '../lib/format.js';

const render = (output: ToolEnvelope, handle: WidgetHandle): void => {
  const root = document.getElementById('root');
  if (root === null) return;

  if (!output.ok) {
    root.innerHTML = `<div class="card"><div class="empty">Căutarea a eșuat: ${esc(output.error ?? 'eroare necunoscută')}</div></div>`;
    return;
  }

  const hits = (output.items ?? []) as readonly SearchHitView[];
  const meta = output.meta ?? {};
  const degraded = meta['degraded'] === true;
  const total =
    typeof meta['estimatedTotalHits'] === 'number' ? meta['estimatedTotalHits'] : hits.length;
  const query = typeof output.query === 'string' ? output.query : '';

  const header = `
    <div class="header">
      <span class="title">Rezultate pentru „${esc(query)}”</span>
      <span class="count muted">${esc(formatNumber(hits.length, {}))} din ~${esc(formatNumber(total, {}))}</span>
    </div>`;

  const degradedNotice = degraded
    ? '<div class="notice degraded">Motorul de căutare este momentan indisponibil — căutarea nu a fost efectuată. Absența unui rezultat nu înseamnă că entitatea nu există; reîncercați mai târziu.</div>'
    : '';

  const body =
    hits.length === 0
      ? `<div class="empty muted">Niciun rezultat pentru „${esc(query)}”.</div>`
      : `<ul class="results" role="listbox">${hits.map((h, i) => renderRow(h, i)).join('')}</ul>`;

  const footer = `
    <div class="footer">
      <span class="muted">transparenta.eu</span>
      <a data-open-site tabindex="0">Deschide căutarea pe site →</a>
    </div>`;

  root.innerHTML = `<div class="card">${header}${degradedNotice}${body}${footer}</div>`;

  for (const rowEl of root.querySelectorAll<HTMLElement>('li.row')) {
    const open = (): void => {
      const hit = hits[Number(rowEl.dataset['index'])];
      if (hit === undefined) return;
      const url = hitHref(hit);
      if (url !== undefined) handle.openLink(url);
    };
    rowEl.addEventListener('click', open);
    rowEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  }
  root.querySelector<HTMLElement>('[data-open-site]')?.addEventListener('click', () => {
    handle.openLink(`${SITE_BASE}/cautare?q=${encodeURIComponent(query)}`);
  });
};

bootstrapWidget('transparenta-entity-search', render);
