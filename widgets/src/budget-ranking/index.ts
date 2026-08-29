/**
 * Budget-ranking widget — renders `rank_budget_entities` as a top-N table
 * with an inline magnitude bar (single validated hue).
 */

import { bootstrapWidget, type ToolEnvelope, type WidgetHandle } from '../lib/bootstrap.js';
import { esc, formatCurrency, formatNumber } from '../lib/format.js';

interface RankedEntityView {
  readonly entityCui?: string;
  readonly entityName?: string | null;
  readonly year?: number;
  readonly amount?: string;
  readonly perCapita?: string | null;
  readonly population?: number | null;
  readonly countyCode?: string | null;
}

interface RankingQuery {
  readonly year?: number;
  readonly metric?: string;
  readonly normalization?: string;
  readonly reportType?: string;
}

const SITE_BASE = 'https://transparenta.eu';

const METRIC_LABELS: Record<string, string> = {
  INCOME: 'venituri',
  EXPENSE: 'cheltuieli',
  BALANCE: 'sold',
};

const NORMALIZATION_SUFFIX: Record<string, string> = {
  TOTAL: '',
  TOTAL_EURO: ' (EUR)',
  PER_CAPITA: ' / locuitor',
  PER_CAPITA_EURO: ' EUR / locuitor',
  PERCENT_GDP: ' (% PIB)',
};

const isEuro = (normalization: string): boolean => normalization.includes('EURO');
const isPercent = (normalization: string): boolean => normalization.includes('PERCENT');

const formatAmount = (amount: string | undefined, normalization: string): string => {
  if (amount === undefined) return 'N/A';
  if (isPercent(normalization)) return `${formatNumber(amount, {})}%`;
  return formatCurrency(amount, {
    compact: true,
    currency: isEuro(normalization) ? 'EUR' : 'RON',
  });
};

const render = (output: ToolEnvelope, handle: WidgetHandle): void => {
  const root = document.getElementById('root');
  if (root === null) return;

  if (!output.ok) {
    root.innerHTML = `<div class="card"><div class="empty">Clasamentul a eșuat: ${esc(output.error ?? 'eroare necunoscută')}</div></div>`;
    return;
  }

  const rows = (output.items ?? []) as readonly RankedEntityView[];
  const query = (output.query ?? {}) as RankingQuery;
  const normalization = query.normalization ?? 'TOTAL';
  const metric = METRIC_LABELS[query.metric ?? 'EXPENSE'] ?? (query.metric ?? '').toLowerCase();
  const suffix = NORMALIZATION_SUFFIX[normalization] ?? '';

  const max = rows.reduce((acc, r) => {
    const v = Math.abs(Number(r.amount ?? 0));
    return Number.isNaN(v) ? acc : Math.max(acc, v);
  }, 0);

  const header = `
    <div class="header">
      <span class="title">Top ${esc(String(rows.length))} entități după ${esc(metric)}${esc(suffix)}</span>
      <span class="context muted">${esc(String(query.year ?? ''))}</span>
    </div>`;

  const body =
    rows.length === 0
      ? '<div class="empty muted">Niciun rezultat.</div>'
      : `<table>
          <thead><tr><th></th><th>Entitate</th><th class="amount">Suma</th><th></th></tr></thead>
          <tbody>
            ${rows
              .map((r, i) => {
                const pct =
                  max > 0 ? Math.max(1, (Math.abs(Number(r.amount ?? 0)) / max) * 100) : 0;
                return `<tr tabindex="0" data-cui="${esc(r.entityCui)}">
                  <td class="rank">${String(i + 1)}</td>
                  <td>
                    <div class="entity">${esc(r.entityName ?? r.entityCui ?? '—')}</div>
                    <div class="sub">CUI ${esc(r.entityCui)}${r.countyCode !== null && r.countyCode !== undefined ? ` · ${esc(r.countyCode)}` : ''}</div>
                  </td>
                  <td class="amount">${esc(formatAmount(r.amount, normalization))}</td>
                  <td class="bar-cell"><div class="bar" style="width:${pct.toFixed(1)}%"></div></td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>`;

  const footer = `
    <div class="footer">
      <span class="muted">transparenta.eu · sume nominale${isEuro(normalization) ? ' EUR' : isPercent(normalization) ? ' % PIB' : ' RON'}</span>
      <a data-open-site tabindex="0">Deschide clasamentul pe site →</a>
    </div>`;

  root.innerHTML = `<div class="card">${header}${body}${footer}</div>`;

  for (const tr of root.querySelectorAll<HTMLElement>('tbody tr')) {
    const open = (): void => {
      const cui = tr.dataset['cui'];
      if (cui !== undefined && cui !== '')
        handle.openLink(`${SITE_BASE}/entitati/${encodeURIComponent(cui)}`);
    };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') open();
    });
  }
  root.querySelector<HTMLElement>('[data-open-site]')?.addEventListener('click', () => {
    handle.openLink(`${SITE_BASE}/buget/clasament`);
  });
};

bootstrapWidget('transparenta-budget-ranking', render);
