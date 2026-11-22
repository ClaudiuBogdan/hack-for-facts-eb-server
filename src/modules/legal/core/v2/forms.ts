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
   * `form_states.readable` (not ended, a text unit is served), narrowed to
   * what THIS surface can serve: a published public composition of exactly
   * one public whole unit, no missing body, no restricted chunk. A header-only
   * or header-plus-body form is therefore not readable here, so it is never
   * the default; this is the one place the rule reads narrower than
   * `default_forms()`, and only for compositions this version does not serve.
   */
  readonly readable: boolean;
  /** A capture that claims the form is held, conflicting or unresolved. */
  readonly held: boolean;
  /** The form's place in the Portal's version list (null: not listed, e.g. the original). */
  readonly portalListPosition: number | null;
  /** The highest Portal page id among the form's current bindings (a tie-break). */
  readonly maxPageId: string | null;
}

export type V2DefaultPolicy = 'latest_any_kind' | 'latest_consolidation_or_original';
export type V2DefaultPosture = 'current' | 'latest_not_available' | 'no_known_form';
export type V2TieBasis =
  | 'only_form_of_the_policy_kinds'
  | 'portal_list_position'
  | 'listed_over_unlisted'
  | 'highest_page_id'
  | 'form_key';

export interface V2DefaultForm {
  readonly actId: string;
  readonly policy: V2DefaultPolicy;
  readonly posture: V2DefaultPosture;
  /** The default: the chosen form, only when it is available (posture current). */
  readonly defaultFormId: string | null;
  /** The form at the latest position, available or not. */
  readonly chosenFormId: string | null;
  /** The latest available form in the same order (the "not the current form" badge). */
  readonly latestAvailableFormId: string | null;
  readonly positionDate: IsoDate | null;
  readonly formsAtPosition: number;
  /** False: two or more forms share the latest date and a reviewer has not ranked them all. */
  readonly orderReviewed: boolean | null;
  /** How an unreviewed tie was broken; null when the order is reviewed. */
  readonly tieBasis: V2TieBasis | null;
  /**
   * Known forms of the policy's kinds that are not available, dated on or after the latest available
   * form's DATE (a lower-ranked form of that same day included); every dated one when none is.
   */
  readonly newerNotAvailable: number;
  /** Known forms of other kinds after the latest position (literal policy only). */
  readonly laterOtherKind: number;
  /** Known forms with no Portal ordering date: counted, never placed. */
  readonly formsWithoutPosition: number;
}

const ALL_KINDS: readonly string[] = ['original', 'republication', 'consolidation'];

/** `x desc nulls last` for a nullable number or bigint string. */
const descNullsLast = (a: bigint | null, b: bigint | null): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : a < b ? 1 : 0;
};
const big = (v: number | string | null): bigint | null =>
  v === null ? null : typeof v === 'number' ? BigInt(v) : /^\d+$/u.test(v) ? BigInt(v) : null;

/**
 * The default form of ONE act: a port, line for line, of the raw function
 * `portal_acts.p2a_default_form` (writer/sql/21-form-states.sql), the owner's
 * decision of 2026-11-12 read as a named policy over per-form facts, default
 * `latest_any_kind`. Order first, availability second:
 *  - every known (not ended) form with a Portal ordering date is ordered by
 *    date, then reviewed rank; the latest date of the policy's kinds is the
 *    latest position, judged among ALL known forms on that date;
 *  - one form there, or every form there ranked: the order is reviewed and
 *    the latest form is the highest rank; otherwise the order stays
 *    unreviewed (`orderReviewed` false) and one fixed rule picks: the form the
 *    Portal lists last, a listed form over an unlisted one, the highest page
 *    id, the greater key;
 *  - only then availability: the chosen form is the default when it is
 *    available (`current`); a newer form that is not available is never
 *    presented as current (`latest_not_available`, with the latest available
 *    form named beside it) and is counted.
 * `day` null reads every known form, future-dated ones included (owner
 * decision: no rule treats a version dated in the future differently); a date
 * reads the act as of that day. The raw function knows no ended act: it reads
 * the lineage's known forms, and so does this.
 */
export const computeDefaultForm = (
  actId: string,
  forms: readonly V2FormState[],
  day: IsoDate | null,
  policy: V2DefaultPolicy = 'latest_any_kind'
): V2DefaultForm => {
  const known = forms.filter((f) => !f.ended);
  const onOrBefore = (d: IsoDate | null): d is IsoDate => d !== null && (day === null || d <= day);
  const dated = known.filter((f) => f.portalOrderDate !== null);
  const dateRanked = (d: IsoDate): boolean =>
    dated.filter((f) => f.portalOrderDate === d).every((f) => f.orderRank !== null);
  const avail = (f: V2FormState): boolean => f.accepted && f.bodyResolved && f.readable;
  const kinds =
    policy === 'latest_any_kind'
      ? ALL_KINDS
      : known.some((f) => f.formKind === 'consolidation' && onOrBefore(f.portalOrderDate))
        ? ['consolidation']
        : ['original'];
  const ofKinds = (f: V2FormState): boolean => kinds.includes(f.formKind);
  /** The SQL's one order: rank where the whole date is ranked, then the fixed rule. */
  const tieOrder = (a: V2FormState, b: V2FormState): number => {
    const rank = (f: V2FormState): bigint | null =>
      f.portalOrderDate !== null && dateRanked(f.portalOrderDate) ? big(f.orderRank) : null;
    const steps = [
      descNullsLast(rank(a), rank(b)),
      Number(b.portalListPosition !== null) - Number(a.portalListPosition !== null),
      descNullsLast(big(a.portalListPosition), big(b.portalListPosition)),
      descNullsLast(big(a.maxPageId), big(b.maxPageId)),
      // `form_key collate "C" desc`
      a.formKey < b.formKey ? 1 : a.formKey > b.formKey ? -1 : 0,
    ];
    return steps.find((step) => step !== 0) ?? 0;
  };
  const formsWithoutPosition = known.length - dated.length;
  const positionDate = known
    .filter((f) => ofKinds(f) && onOrBefore(f.portalOrderDate))
    .reduce<IsoDate | null>(
      (max, f) => (max === null || (f.portalOrderDate ?? '') > max ? f.portalOrderDate : max),
      null
    );
  if (positionDate === null) {
    return {
      actId,
      policy,
      posture: 'no_known_form',
      defaultFormId: null,
      chosenFormId: null,
      latestAvailableFormId: null,
      positionDate: null,
      formsAtPosition: 0,
      orderReviewed: null,
      tieBasis: null,
      newerNotAvailable: 0,
      laterOtherKind: 0,
      formsWithoutPosition,
    };
  }
  const atPosition = dated.filter((f) => f.portalOrderDate === positionDate);
  const level = atPosition.length;
  const orderReviewed = level === 1 || atPosition.every((f) => f.orderRank !== null);
  const laterOtherKind = dated.filter(
    (f) => (f.portalOrderDate ?? '') > positionDate && onOrBefore(f.portalOrderDate) && !ofKinds(f)
  ).length;
  const latestAvailable = known
    .filter((f) => ofKinds(f) && onOrBefore(f.portalOrderDate) && avail(f))
    .sort((a, b) =>
      (a.portalOrderDate ?? '') < (b.portalOrderDate ?? '')
        ? 1
        : (a.portalOrderDate ?? '') > (b.portalOrderDate ?? '')
          ? -1
          : tieOrder(a, b)
    )[0];
  const newerNotAvailable = known.filter(
    (f) =>
      ofKinds(f) &&
      onOrBefore(f.portalOrderDate) &&
      !avail(f) &&
      (latestAvailable === undefined ||
        f.portalOrderDate >= (latestAvailable.portalOrderDate ?? ''))
  ).length;
  const ranked = atPosition.filter(ofKinds).sort(tieOrder);
  const top = ranked[0];
  const next = ranked[1];
  let tieBasis: V2TieBasis | null = null;
  if (!orderReviewed && top !== undefined) {
    tieBasis =
      next === undefined
        ? 'only_form_of_the_policy_kinds'
        : top.portalListPosition !== null && next.portalListPosition !== null
          ? 'portal_list_position'
          : top.portalListPosition !== null
            ? 'listed_over_unlisted'
            : big(top.maxPageId) !== big(next.maxPageId)
              ? 'highest_page_id'
              : 'form_key';
  }
  const maxRank = atPosition.reduce<number | null>(
    (m, f) => (f.orderRank === null ? m : m === null || f.orderRank > m ? f.orderRank : m),
    null
  );
  const rankedAboveByOtherKind =
    orderReviewed && level > 1 && top !== undefined && top.orderRank !== maxRank;
  const current = top !== undefined && !rankedAboveByOtherKind && avail(top);
  return {
    actId,
    policy,
    posture: current ? 'current' : 'latest_not_available',
    defaultFormId: current ? top.formId : null,
    chosenFormId: top?.formId ?? null,
    latestAvailableFormId: latestAvailable?.formId ?? null,
    positionDate,
    formsAtPosition: level,
    orderReviewed,
    tieBasis,
    newerNotAvailable,
    laterOtherKind,
    formsWithoutPosition,
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
