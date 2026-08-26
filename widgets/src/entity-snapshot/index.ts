/**
 * Entity-snapshot widget — renders the kernel `get_entity_snapshot` as an
 * entity card: identity, money-flow stat tiles, per-source presence badges.
 */

import { bootstrapWidget, type ToolEnvelope, type WidgetHandle } from '../lib/bootstrap.js';
import { esc, formatCurrency, formatNumber } from '../lib/format.js';

interface FlowSummaryView {
  readonly count?: number;
  readonly totalAmountRon?: string;
  readonly minYear?: number | null;
  readonly maxYear?: number | null;
}

interface SnapshotView {
  readonly cui?: string;
  readonly organization?: { name?: string; kind?: string; countyName?: string | null } | null;
  readonly territory?: { countyName?: string | null; uatName?: string | null } | null;
  readonly flowsIn?: FlowSummaryView;
  readonly flowsOut?: FlowSummaryView;
  readonly documentCount?: number;
  readonly presence?: readonly {
    source: string;
    present: boolean;
    label?: string;
    count?: number;
  }[];
}

const SITE_BASE = 'https://transparenta.eu';

const yearsRange = (flow: FlowSummaryView | undefined): string => {
  if (flow?.minYear === null || flow?.minYear === undefined) return '';
  const max = flow.maxYear ?? flow.minYear;
  return flow.minYear === max ? String(flow.minYear) : `${String(flow.minYear)}–${String(max)}`;
};

const render = (output: ToolEnvelope, handle: WidgetHandle): void => {
  const root = document.getElementById('root');
  if (root === null) return;

  if (!output.ok) {
    root.innerHTML = `<div class="card"><div class="empty">Profilul a eșuat: ${esc(output.error ?? 'eroare necunoscută')}</div></div>`;
    return;
  }

  const item = (output.item ?? {}) as SnapshotView;
  const org = item.organization;
  const county = org?.countyName ?? item.territory?.countyName;

  const header = `
    <div class="header">
      <div class="name">${esc(org?.name ?? `CUI ${item.cui ?? ''}`)}</div>
      <div class="meta">
        <span>CUI ${esc(item.cui)}</span>
        ${org?.kind !== undefined ? `<span>${esc(org.kind)}</span>` : ''}
        ${county !== null && county !== undefined ? `<span>📍 ${esc(county)}</span>` : ''}
      </div>
    </div>`;

  const stat = (label: string, value: string, sub: string): string => `
    <div class="stat">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(value)}</div>
      ${sub !== '' ? `<div class="sub">${esc(sub)}</div>` : ''}
    </div>`;

  const stats = `<div class="stats">
    ${stat(
      'Încasări',
      formatCurrency(item.flowsIn?.totalAmountRon, { compact: true }),
      `${formatNumber(item.flowsIn?.count ?? 0, {})} fluxuri ${yearsRange(item.flowsIn)}`
    )}
    ${stat(
      'Plăți',
      formatCurrency(item.flowsOut?.totalAmountRon, { compact: true }),
      `${formatNumber(item.flowsOut?.count ?? 0, {})} fluxuri ${yearsRange(item.flowsOut)}`
    )}
    ${stat('Documente', formatNumber(item.documentCount ?? 0, {}), 'în toate sursele')}
  </div>`;

  const presence = (item.presence ?? [])
    .map(
      (p) =>
        `<span class="badge ${p.present ? 'on' : 'off'}">${esc(p.label ?? p.source)}${p.count !== undefined && p.count > 0 ? ` · ${esc(formatNumber(p.count, { compact: true }))}` : ''}</span>`
    )
    .join('');

  const footer = `
    <div class="footer">
      <span class="muted">transparenta.eu</span>
      <a data-open-site tabindex="0">Deschide profilul pe site →</a>
    </div>`;

  root.innerHTML = `<div class="card">${header}${stats}${presence !== '' ? `<div class="presence">${presence}</div>` : ''}${footer}</div>`;

  root.querySelector<HTMLElement>('[data-open-site]')?.addEventListener('click', () => {
    const cui = item.cui ?? '';
    handle.openLink(cui !== '' ? `${SITE_BASE}/entitati/${cui}` : SITE_BASE);
  });
};

bootstrapWidget('transparenta-entity-snapshot', render);
