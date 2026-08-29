/**
 * Entity-search widget — renders `search_entities` results as the client's
 * entity palette does: type badge, title, subtitle, CUI, county, inactive chip.
 */

import { bootstrapWidget, type ToolEnvelope, type WidgetHandle } from '../lib/bootstrap.js';
import { esc, formatNumber } from '../lib/format.js';

interface SearchHitView {
  readonly docType?: string;
  readonly docKey?: string;
  readonly docId?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly countyName?: string;
  readonly url?: string;
  readonly cuis?: readonly string[];
  readonly attrs?: Record<string, unknown>;
}

const SITE_BASE = 'https://transparenta.eu';

const DOC_TYPE_LABELS: Record<string, string> = {
  company: 'Companie',
  organization: 'Instituție publică',
  public_institution: 'Instituție publică',
  public_enterprise: 'Întrepr. publică',
  ngo: 'ONG',
  pnrr_entity: 'PNRR',
  mp: 'Parlamentar',
  bill: 'Proiect de lege',
  committee: 'Comisie',
  legal_act: 'Act normativ',
  mo_act: 'Monitorul Oficial',
  uat: 'UAT',
};

/** Doc types whose identity spine is the CUI (mirrors the client row logic). */
const CUI_DOC_TYPES = new Set(['company', 'organization', 'public_enterprise', 'ngo']);

const docTypeLabel = (docType: string | undefined): string => {
  if (docType === undefined || docType === '') return 'Entitate';
  return DOC_TYPE_LABELS[docType] ?? docType.replace(/_/g, ' ');
};

const isInactive = (hit: SearchHitView): boolean => {
  const status = hit.attrs?.['status'];
  if (typeof status !== 'string') return false;
  return /inactiv|radiat|dizolv|închis|inchis|repealed|struck/i.test(status);
};

/**
 * `url` originates in the search index over scraped data — treat it as
 * untrusted. Allow only absolute http(s) URLs (the field's purpose: external
 * source deep-links) or site-relative paths; anything else (other schemes,
 * protocol-relative `//`, host-suffix fragments) is dropped.
 */
const hitUrl = (hit: SearchHitView): string | undefined => {
  const url = hit.url;
  if (url === undefined || url === '') return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return `${SITE_BASE}${url}`;
  return undefined;
};

const renderRow = (hit: SearchHitView, index: number): string => {
  const cui =
    hit.docType !== undefined && CUI_DOC_TYPES.has(hit.docType) ? hit.cuis?.[0] : undefined;
  const metaParts: string[] = [];
  if (hit.subtitle !== undefined && hit.subtitle !== '' && hit.subtitle !== hit.title) {
    metaParts.push(esc(hit.subtitle));
  }
  if (cui !== undefined) metaParts.push(`CUI ${esc(cui)}`);
  if (hit.countyName !== undefined && hit.countyName !== '') {
    metaParts.push(`📍 ${esc(hit.countyName)}`);
  }
  return `
    <li class="row" tabindex="0" role="option" data-index="${String(index)}" aria-label="${esc(hit.title)}">
      <div class="row-top">
        <span class="badge${hit.docType === 'company' || hit.docType === 'organization' ? ' accent' : ''}">${esc(docTypeLabel(hit.docType))}</span>
        <span class="row-title">${esc(hit.title)}</span>
        ${isInactive(hit) ? '<span class="chip-inactive">Inactiv</span>' : ''}
      </div>
      ${metaParts.length > 0 ? `<div class="row-meta">${metaParts.map((p) => `<span>${p}</span>`).join('')}</div>` : ''}
    </li>`;
};

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
    ? '<div class="notice degraded">Motorul de căutare este momentan indisponibil — doar identificatorii exacți (CUI) se rezolvă. Absența unui rezultat nu înseamnă că entitatea nu există.</div>'
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
      const url = hitUrl(hit);
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
