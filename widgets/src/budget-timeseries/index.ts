/**
 * Budget-timeseries widget — renders `get_budget_timeseries` as a single-series
 * SVG line chart (2px line, recessive grid, endpoint value labels, nearest-point
 * hover tooltip) with a table view toggle.
 */

import { bootstrapWidget, type ToolEnvelope, type WidgetHandle } from '../lib/bootstrap.js';
import { esc, formatCurrency, formatNumber } from '../lib/format.js';

interface SeriesPointView {
  readonly periodLabel?: string;
  readonly amount?: string;
}

interface TimeseriesQuery {
  readonly cui?: string;
  readonly metric?: string;
  readonly frequency?: string;
  readonly normalization?: string;
}

const SITE_BASE = 'https://transparenta.eu';

const METRIC_LABELS: Record<string, string> = {
  INCOME: 'Venituri',
  EXPENSE: 'Cheltuieli',
  BALANCE: 'Sold',
};

const W = 640;
const H = 240;
const PAD = { top: 18, right: 84, bottom: 26, left: 10 };

const formatAmount = (amount: string | number | undefined, normalization: string): string => {
  if (amount === undefined) return 'N/A';
  if (normalization.includes('PERCENT')) return `${formatNumber(amount, { compact: true })}%`;
  return formatCurrency(amount, {
    compact: true,
    currency: normalization.includes('EURO') ? 'EUR' : 'RON',
  });
};

const render = (output: ToolEnvelope, handle: WidgetHandle): void => {
  const root = document.getElementById('root');
  if (root === null) return;

  if (!output.ok) {
    root.innerHTML = `<div class="card"><div class="empty">Seria a eșuat: ${esc(output.error ?? 'eroare necunoscută')}</div></div>`;
    return;
  }

  const points = ((output.items ?? []) as readonly SeriesPointView[]).filter(
    (p) => p.periodLabel !== undefined && !Number.isNaN(Number(p.amount))
  );
  const query = (output.query ?? {}) as TimeseriesQuery;
  const normalization = query.normalization ?? 'TOTAL';
  const metric = METRIC_LABELS[query.metric ?? 'EXPENSE'] ?? 'Valori';

  const header = `
    <div class="header">
      <span class="title">${esc(metric)} — ${esc(query.cui ?? '')}</span>
      <span class="context muted">${esc(points[0]?.periodLabel ?? '')}–${esc(points[points.length - 1]?.periodLabel ?? '')}</span>
    </div>`;

  if (points.length === 0) {
    root.innerHTML = `<div class="card">${header}<div class="empty muted">Nicio valoare disponibilă.</div></div>`;
    return;
  }

  const values = points.map((p) => Number(p.amount));
  const min = Math.min(...values, 0);
  const max = Math.max(...values);
  const span = max - min || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number): number =>
    PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number): number => PAD.top + plotH - ((v - min) / span) * plotH;

  const path = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join('');

  // Recessive grid: 3 horizontal lines (min, mid, max).
  const gridYs = [min, min + span / 2, max];
  const grid = gridYs
    .map(
      (v) =>
        `<line class="grid-line" x1="${String(PAD.left)}" x2="${String(W - PAD.right)}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"></line>
         <text class="axis-label" x="${String(W - PAD.right + 4)}" y="${(y(v) + 3).toFixed(1)}">${esc(formatAmount(v, normalization))}</text>`
    )
    .join('');

  // X labels: first, middle, last (collision-free for any length).
  const xIdx =
    points.length > 2
      ? [0, Math.floor((points.length - 1) / 2), points.length - 1]
      : points.map((_, i) => i);
  const xLabels = [...new Set(xIdx)]
    .map((i) => {
      const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
      return `<text class="axis-label" text-anchor="${anchor}" x="${x(i).toFixed(1)}" y="${String(H - 8)}">${esc(points[i]?.periodLabel)}</text>`;
    })
    .join('');

  const lastIndex = points.length - 1;
  const endLabel = `<text class="value-label" text-anchor="end" x="${x(lastIndex).toFixed(1)}" y="${(y(values[lastIndex] ?? 0) - 8).toFixed(1)}">${esc(formatAmount(values[lastIndex], normalization))}</text>`;

  const dots = values
    .map(
      (v, i) =>
        `<circle class="dot" data-i="${String(i)}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5"></circle>`
    )
    .join('');

  const tableRows = points
    .map(
      (p, i) =>
        `<tr><td>${esc(p.periodLabel)}</td><td class="amount">${esc(formatAmount(values[i], normalization))}</td></tr>`
    )
    .join('');

  root.innerHTML = `<div class="card">
    ${header}
    <div class="chart-wrap">
      <svg viewBox="0 0 ${String(W)} ${String(H)}" role="img" aria-label="${esc(metric)} pe perioade">
        ${grid}
        <path class="series" d="${path}"></path>
        ${dots}
        ${endLabel}
        ${xLabels}
      </svg>
      <div class="tooltip" data-tooltip></div>
    </div>
    <div class="table-toggle"><a data-toggle tabindex="0">Afișează tabelul</a></div>
    <table class="hidden" data-table>
      <thead><tr><th>Perioada</th><th class="amount">Suma</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    <div class="footer">
      <span class="muted">transparenta.eu</span>
      <a data-open-site tabindex="0">Deschide pe site →</a>
    </div>
  </div>`;

  // Nearest-point hover tooltip over the whole plot area.
  const wrap = root.querySelector<HTMLElement>('.chart-wrap');
  const tooltip = root.querySelector<HTMLElement>('[data-tooltip]');
  const svg = root.querySelector<SVGSVGElement>('svg');
  if (wrap !== null && tooltip !== null && svg !== null) {
    wrap.addEventListener('mousemove', (event) => {
      const rect = svg.getBoundingClientRect();
      const relX = ((event.clientX - rect.left) / rect.width) * W;
      let nearest = 0;
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < points.length; i += 1) {
        const d = Math.abs(x(i) - relX);
        if (d < best) {
          best = d;
          nearest = i;
        }
      }
      const point = points[nearest];
      if (point === undefined) return;
      tooltip.innerHTML = `${esc(point.periodLabel)} · <span class="val">${esc(formatAmount(values[nearest], normalization))}</span>`;
      tooltip.style.display = 'block';
      const px = (x(nearest) / W) * rect.width;
      const py = (y(values[nearest] ?? 0) / H) * rect.height;
      tooltip.style.left = `${String(Math.min(px + 10, rect.width - 130))}px`;
      tooltip.style.top = `${String(Math.max(py - 34, 0))}px`;
    });
    wrap.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });
  }

  root.querySelector<HTMLElement>('[data-toggle]')?.addEventListener('click', (event) => {
    const table = root.querySelector<HTMLElement>('[data-table]');
    const link = event.currentTarget as HTMLElement;
    if (table !== null) {
      const hidden = table.classList.toggle('hidden');
      link.textContent = hidden ? 'Afișează tabelul' : 'Ascunde tabelul';
    }
  });
  root.querySelector<HTMLElement>('[data-open-site]')?.addEventListener('click', () => {
    const cui = query.cui ?? '';
    handle.openLink(cui !== '' ? `${SITE_BASE}/entitati/${encodeURIComponent(cui)}` : SITE_BASE);
  });
};

bootstrapWidget('transparenta-budget-timeseries', render);
