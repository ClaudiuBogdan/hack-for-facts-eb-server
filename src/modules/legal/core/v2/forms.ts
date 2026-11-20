/**
 * legal_v2 forms → the `LegalDocument` contract (pure; no I/O).
 *
 * A legal_v2 act has FORMS (original, republication, consolidation). The page's
 * version list is the act's forms: `documentId` is `f<form_id>` so it can never
 * collide with an old numeric Portal page id, which the read path still accepts
 * and resolves through `page_targets` (see `parseDocumentRef`).
 *
 * The default form is the rule of rebuild-model.md §7 and of the serving
 * function `legal_v2.default_forms(date)` (04-serving-views.sql), mirrored here
 * line for line and computed per act from the forms of that act: the role's
 * statement timeout (15 s) forbids calling `default_forms` per request, since it
 * computes every act. The SQL header says the function predates the owner's
 * decisions of 2026-11-12 (latest form of any kind, Portal list order for
 * unranked same-date forms); the design binds this API to §7, so this is the
 * earlier literal rule, on purpose.
 */

import type { IsoDate } from '@/modules/shared/index.js';

export type V2FormKind = 'original' | 'republication' | 'consolidation';

/** The old `version_kind` vocabulary the client already renders. */
export const V2_FORM_KIND_TO_VERSION_KIND: Readonly<Record<V2FormKind, string>> = {
  original: 'original',
  republication: 'republicare',
  consolidation: 'consolidare',
};

export const versionKindOf = (kind: string): string =>
  Object.hasOwn(V2_FORM_KIND_TO_VERSION_KIND, kind)
    ? V2_FORM_KIND_TO_VERSION_KIND[kind as V2FormKind]
    : kind;

const FORM_DOC_RE = /^f([1-9]\d{0,17})$/u;
const PAGE_ID_RE = /^[1-9]\d{0,17}$/u;

/** `f<form_id>` — the v2 document id of a form. */
export const formDocumentId = (formId: string): string => `f${formId}`;

export type V2DocumentRef =
  | { readonly kind: 'form'; readonly formId: string }
  | { readonly kind: 'page'; readonly pageId: string }
  | { readonly kind: 'invalid' };

/**
 * `f123` names a form; a bare positive integer is an old Portal page id (the
 * old `act_documents.document_id`), resolved through `page_targets` to the form
 * the page shows now. Anything else is not an id this source holds.
 */
export const parseDocumentRef = (documentId: string): V2DocumentRef => {
  const form = FORM_DOC_RE.exec(documentId);
  if (form?.[1] !== undefined) return { kind: 'form', formId: form[1] };
  if (PAGE_ID_RE.test(documentId)) return { kind: 'page', pageId: documentId };
  return { kind: 'invalid' };
};

/**
 * The routes of one page id, in the order an old document id is read. The old
 * corpus compiled the DetaliiDocumentAfis capture of each page, so `afis` comes
 * first; one page id can show different forms on different routes (page
 * 52548), which is why the route is chosen, never guessed from the form.
 */
export const PAGE_ROUTE_PREFERENCE: readonly string[] = ['afis', 'detail', 'detail_base', 'print'];

/** The facts about one form the default rule and the version list read. */
export interface V2FormState {
  readonly formId: string;
  readonly actId: string;
  readonly formKind: string;
  readonly formKey: string;
  readonly portalOrderDate: IsoDate | null;
  readonly orderRank: number | null;
  readonly accepted: boolean;
  readonly bodyResolved: boolean;
  readonly ended: boolean;
  /**
   * `form_states.readable`: not ended and a component with a text unit is
   * served. Here additionally restricted components do not count: a form whose
   * only text is restricted is not readable for this public surface.
   */
  readonly readable: boolean;
  /** A capture that claims the form is held, conflicting or unresolved. */
  readonly held: boolean;
}

export type V2DefaultBasis = 'latest_consolidation' | 'original';

export interface V2DefaultForm {
  readonly actId: string;
  readonly defaultFormId: string | null;
  readonly basis: V2DefaultBasis | null;
  readonly defaultPortalDate: IsoDate | null;
  /** Consolidations dated up to the day that exist and cannot be shown. */
  readonly newerNotAvailable: number;
  /** Forms (any kind) dated after the day. */
  readonly futureForms: number;
  /** Republications dated after the default (owner question 6: only counted). */
  readonly newerRepublications: number;
}

const cmpDesc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

/** `(date, coalesce(rank, 0)) > (p.date, coalesce(p.rank, 0))` — SQL row comparison. */
const tupleAfter = (
  date: IsoDate,
  rank: number | null,
  pDate: IsoDate,
  pRank: number | null
): boolean => (date !== pDate ? date > pDate : (rank ?? 0) > (pRank ?? 0));

/**
 * The default form of ONE act on day `asOf`, exactly as `default_forms` reads
 * it. `forms` are all of the act's (public) forms; `actEnded` mirrors the
 * function's `where not a.ended` (an ended act has no default).
 */
export const computeDefaultForm = (
  actId: string,
  forms: readonly V2FormState[],
  asOf: IsoDate,
  actEnded = false
): V2DefaultForm => {
  const none: V2DefaultForm = {
    actId,
    defaultFormId: null,
    basis: null,
    defaultPortalDate: null,
    newerNotAvailable: 0,
    futureForms: 0,
    newerRepublications: 0,
  };
  if (actEnded) return none;

  // cons: live consolidations; the window is (act, portal_order_date) over
  // consolidations only, with NULL dates forming one group (SQL partitioning).
  const cons = forms.filter((f) => f.formKind === 'consolidation' && !f.ended);
  const groups = new Map<string, V2FormState[]>();
  for (const c of cons) {
    const key = c.portalOrderDate ?? '\u0000null';
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [c]);
    else list.push(c);
  }
  const available = (c: V2FormState): boolean => {
    const group = groups.get(c.portalOrderDate ?? '\u0000null') ?? [c];
    const unordered = group.length > 1 && group.some((g) => g.orderRank === null);
    return c.accepted && c.bodyResolved && c.readable && !unordered;
  };

  // picked: available, dated, not after the day; date desc, rank desc NULLS LAST.
  const candidates = cons
    .filter((c) => available(c) && c.portalOrderDate !== null && c.portalOrderDate <= asOf)
    .sort((a, b) => {
      const byDate = cmpDesc(a.portalOrderDate ?? '', b.portalOrderDate ?? '');
      if (byDate !== 0) return byDate;
      if (a.orderRank === null && b.orderRank === null) return 0;
      if (a.orderRank === null) return 1;
      if (b.orderRank === null) return -1;
      return b.orderRank - a.orderRank;
    });
  const picked = candidates[0];

  // orig: the function joins every qualifying original (one per act in
  // practice); the lowest form id makes a duplicate deterministic.
  const orig = forms
    .filter(
      (f) => f.formKind === 'original' && !f.ended && f.accepted && f.bodyResolved && f.readable
    )
    .sort((a, b) => (BigInt(a.formId) < BigInt(b.formId) ? -1 : 1))[0];

  const chosen = picked ?? orig;
  const chosenDate = chosen?.portalOrderDate ?? null;

  const newerNotAvailable = cons.filter(
    (c) =>
      c.portalOrderDate !== null &&
      c.portalOrderDate <= asOf &&
      (picked === undefined ||
        tupleAfter(c.portalOrderDate, c.orderRank, picked.portalOrderDate ?? '', picked.orderRank))
  ).length;
  const futureForms = forms.filter(
    (f) => !f.ended && f.portalOrderDate !== null && f.portalOrderDate > asOf
  ).length;
  const newerRepublications = forms.filter(
    (f) =>
      !f.ended &&
      f.formKind === 'republication' &&
      f.portalOrderDate !== null &&
      f.portalOrderDate <= asOf &&
      (chosen === undefined || chosenDate === null || f.portalOrderDate > chosenDate)
  ).length;

  return {
    actId,
    defaultFormId: chosen?.formId ?? null,
    basis: picked !== undefined ? 'latest_consolidation' : orig !== undefined ? 'original' : null,
    defaultPortalDate: chosenDate,
    newerNotAvailable,
    futureForms,
    newerRepublications,
  };
};

/** Today in Europe/Bucharest as YYYY-MM-DD (the Portal's own calendar). */
export const bucharestToday = (now: Date = new Date()): IsoDate =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
