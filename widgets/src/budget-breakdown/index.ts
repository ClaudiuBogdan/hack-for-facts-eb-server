/**
 * Budget-breakdown widget — renders `aggregate_budget_by_classification` as a
 * horizontal bar list (functional × economic buckets, share of shown total).
 */

import { bootstrapWidget, type ToolEnvelope, type WidgetHandle } from '../lib/bootstrap.js';
import { esc, formatCurrency } from '../lib/format.js';

interface BucketView {
  readonly functionalCode?: string;
  readonly functionalName?: string | null;
  readonly economicCode?: string | null;
  readonly economicName?: string | null;
  readonly amount?: string;
  readonly lineCount?: number;
}

interface AggregateQuery {
  readonly year?: number;
  readonly accountCategory?: string;
  readonly entityCui?: string | null;
}

const SITE_BASE = 'https://transparenta.eu';

const bucketLabel = (b: BucketView): { name: string; code: string } => {
  const fn = b.functionalName ?? b.functionalCode ?? '—';
  const ec = b.economicName ?? b.economicCode;
  return {
    name: ec !== null && ec !== undefined && ec !== '' ? `${fn} · ${ec}` : fn,
    code: `${b.functionalCode ?? ''}${b.economicCode !== null && b.economicCode !== undefined ? ` / ${b.economicCode}` : ''}`,
  };
};

const render = (output: ToolEnvelope, handle: WidgetHandle): void => {
  const root = document.getElementById('root');
  if (root === null) return;

  if (!output.ok) {
    root.innerHTML = `<div class="card"><div class="empty">Agregarea a eșuat: ${esc(output.error ?? 'eroare necunoscută')}</div></div>`;
    return;
  }

  const buckets = (output.items ?? []) as readonly BucketView[];
  const query = (output.query ?? {}) as AggregateQuery;
  const category = query.accountCategory === 'INCOME' ? 'venituri' : 'cheltuieli';

  const amounts = buckets.map((b) => Math.abs(Number(b.amount ?? 0)));
  const max = Math.max(...amounts, 0);
  const total = amounts.reduce((a, v) => a + (Number.isNaN(v) ? 0 : v), 0);

  const header = `
    <div class="header">
      <span class="title">Structura pe clasificații — ${esc(category)}</span>
      <span class="context muted">${esc(String(query.year ?? ''))}${query.entityCui !== null && query.entityCui !== undefined ? ` · CUI ${esc(query.entityCui)}` : ''}</span>
    </div>`;

  const body =
    buckets.length === 0
      ? '<div class="empty muted">Nicio valoare disponibilă.</div>'
      : `<ul class="buckets">
        ${buckets
          .map((b, i) => {
            const value = amounts[i] ?? 0;
            const pct = max > 0 ? Math.max(1, (value / max) * 100) : 0;
            const share = total > 0 ? ((value / total) * 100).toFixed(1).replace('.', ',') : '0';
            const { name, code } = bucketLabel(b);
            return `<li class="bucket" title="${esc(code)}">
              <div class="bucket-top">
                <span class="bucket-name">${esc(name)} <span class="bucket-code">${esc(code)}</span></span>
                <span class="bucket-amount">${esc(formatCurrency(b.amount, { compact: true }))} <span class="bucket-share">${esc(share)}%</span></span>
              </div>
              <div class="bar-track"><div class="bar" style="width:${pct.toFixed(1)}%"></div></div>
            </li>`;
          })
          .join('')}
      </ul>`;

  const footer = `
    <div class="footer">
      <span class="muted">transparenta.eu · % din totalul afișat</span>
      <a data-open-site tabindex="0">Deschide pe site →</a>
    </div>`;

  root.innerHTML = `<div class="card">${header}${body}${footer}</div>`;

  root.querySelector<HTMLElement>('[data-open-site]')?.addEventListener('click', () => {
    handle.openLink(`${SITE_BASE}/buget/clasificatie`);
  });
};

bootstrapWidget('transparenta-budget-breakdown', render);
