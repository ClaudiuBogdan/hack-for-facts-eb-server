/**
 * Entity-search widget — one result row as HTML: type badge, title, status
 * chip, then subtitle, CUI (or a CUI-less NGO's registry number) and county.
 * Pure (no DOM), so it is unit-tested apart from the widget's bootstrap. Every
 * value from the payload goes through `esc`.
 */

import { ngoStatusChip } from './hit-link.js';
import { esc } from '../lib/format.js';

export interface SearchHitView {
  readonly docType?: string;
  readonly docKey?: string;
  readonly docId?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly countyName?: string;
  readonly url?: string;
  /** The client page the server built for this hit (registry NGOs). */
  readonly link?: string;
  readonly cuis?: readonly string[];
  readonly ngoRegistryNumber?: string;
  /** The NGO registry's legal status (`Inregistrat`, `Radiat`, `Dizolvata`, `In Lichidare`). */
  readonly ngoRegistryStatus?: string;
  readonly attrs?: Record<string, unknown>;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  company: 'Companie',
  organization: 'Instituție publică',
  public_institution: 'Instituție publică',
  public_enterprise: 'Întrepr. publică',
  ngo: 'ONG',
  organization_unclassified: 'Organizație',
  pnrr_entity: 'PNRR',
  mp: 'Parlamentar',
  bill: 'Proiect de lege',
  committee: 'Comisie',
  legal_act: 'Act normativ',
  mo_act: 'Monitorul Oficial',
  uat: 'UAT',
};

/** Doc types whose identity spine is the CUI (mirrors the client row logic). */
const CUI_DOC_TYPES = new Set([
  'company',
  'organization',
  'public_enterprise',
  'ngo',
  'organization_unclassified',
]);

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
 * A row the NGO registry holds — an NGO, or a registry organisation the index
 * files under another type (its registry number says so), or a hit carrying
 * a registry status — decided before its status is read.
 */
const isRegistryHit = (hit: SearchHitView): boolean =>
  hit.docType === 'ngo' ||
  (hit.ngoRegistryNumber !== undefined && hit.ngoRegistryNumber.trim() !== '') ||
  hit.ngoRegistryStatus !== undefined;

/**
 * A registry row's chip is only its legal registry status (none where the
 * status is absent, registered or unknown): the generic attributes never decide
 * it. Any other hit keeps the generic „Inactiv" its attributes suggest.
 */
const statusChip = (hit: SearchHitView): string | undefined => {
  if (isRegistryHit(hit)) return ngoStatusChip(hit.ngoRegistryStatus);
  return isInactive(hit) ? 'Inactiv' : undefined;
};

export const renderRow = (hit: SearchHitView, index: number): string => {
  const cui =
    hit.docType !== undefined && CUI_DOC_TYPES.has(hit.docType) ? hit.cuis?.[0] : undefined;
  const metaParts: string[] = [];
  if (hit.subtitle !== undefined && hit.subtitle !== '' && hit.subtitle !== hit.title) {
    metaParts.push(esc(hit.subtitle));
  }
  if (cui !== undefined) metaParts.push(`CUI ${esc(cui)}`);
  else if (hit.ngoRegistryNumber !== undefined && hit.ngoRegistryNumber !== '') {
    metaParts.push(`Nr. registru ${esc(hit.ngoRegistryNumber)}`);
  }
  if (hit.countyName !== undefined && hit.countyName !== '') {
    metaParts.push(`📍 ${esc(hit.countyName)}`);
  }
  const chip = statusChip(hit);
  return `
    <li class="row" tabindex="0" role="option" data-index="${String(index)}" aria-label="${esc(hit.title)}">
      <div class="row-top">
        <span class="badge${hit.docType === 'company' || hit.docType === 'organization' ? ' accent' : ''}">${esc(docTypeLabel(hit.docType))}</span>
        <span class="row-title">${esc(hit.title)}</span>
        ${chip !== undefined ? `<span class="chip-inactive">${esc(chip)}</span>` : ''}
      </div>
      ${metaParts.length > 0 ? `<div class="row-meta">${metaParts.map((p) => `<span>${p}</span>`).join('')}</div>` : ''}
    </li>`;
};
