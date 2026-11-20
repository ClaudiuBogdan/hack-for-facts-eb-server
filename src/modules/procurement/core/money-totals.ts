/**
 * Totals v2 core (docs/server-redesign/10-public-contracts-totals-v2.md): a
 * total is defined by its filters alone. The API sums what the filters ask
 * and says, with counts, what went in and what was left out. No stored rules.
 *
 * Pure: the shell reads one aggregate per filter set (rows grouped by every
 * dimension a decision below needs) and the label table of the same build;
 * this module decides membership, sums, exclusions and the explanation.
 * Money is integer bani (BigInt) until it is rendered as a lei decimal string.
 *
 * Invariant (tested): per value kind, included + Σ exclusions = population,
 * in count and in value, where the population is every fact of that value
 * kind under the request's non-status, non-amount filters.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  disclosureKeyOf,
  invalidInput,
  serviceUnavailable,
  type ApiError,
  type SupplierDisclosurePort,
} from '@/modules/shared/index.js';

export const PROCUREMENT_KINDS = [
  'direct_acquisition',
  'contract_award',
  'market_consultation',
  'advertising_notice',
  'direct_award_notification',
] as const;
export type ProcurementKind = (typeof PROCUREMENT_KINDS)[number];

export const VALUE_KINDS = [
  'awarded',
  'reported',
  'estimate',
  'framework_ceiling',
  'modification_change',
] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export const STATUSES = [
  'awarded',
  'refused',
  'cancelled',
  'removed_from_portal',
  'under_review',
  'identity_review',
  'withdrawn',
] as const;
export type FactStatus = (typeof STATUSES)[number];

export const CONTRACT_KINDS = ['ordinary', 'call_off', 'framework_agreement'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

export const VAT_BASES = ['excluded', 'included', 'unknown'] as const;
export type VatBasis = (typeof VAT_BASES)[number];

/** The exclusion keys the label table defines (schema draft 2). */
export type ExclusionKey =
  | 'no_value'
  | 'undated'
  | 'withheld_d6'
  | 'not_additive'
  | 'association_unattributed'
  | 'identity_review'
  | `status:${FactStatus}`;

export const MAX_TOTALS_REQUESTS = 8;

/** The filters a client sends (GraphQL has checked the types). */
export interface TotalsFiltersInput {
  readonly procurementKinds?: readonly string[] | null;
  readonly contractKinds?: readonly string[] | null;
  readonly statuses?: readonly string[] | null;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly buyerCode?: string | null;
  readonly supplierCode?: string | null;
  readonly cpvPrefix?: string | null;
  readonly countyCode?: string | null;
  readonly siruta?: string | null;
  readonly vatBases?: readonly string[] | null;
  readonly q?: string | null;
}

export interface TotalsRequestInput {
  readonly id: string;
  readonly filters?: TotalsFiltersInput | null;
  readonly valueKinds?: readonly string[] | null;
  readonly currencySubtotals?: boolean | null;
}

/** A request with every default applied; what the shell reads and the answer echoes. */
export interface TotalsFilters {
  readonly procurementKinds: readonly ProcurementKind[];
  readonly contractKinds: readonly ContractKind[] | null;
  readonly statuses: readonly FactStatus[];
  readonly from: string | null;
  readonly to: string | null;
  readonly buyerCode: string | null;
  readonly supplierCode: string | null;
  readonly cpvPrefix: string | null;
  readonly countyCode: string | null;
  readonly siruta: string | null;
  readonly vatBases: readonly VatBasis[] | null;
  readonly q: string | null;
}

export interface TotalsRequest {
  readonly id: string;
  readonly filters: TotalsFilters;
  readonly valueKinds: readonly ValueKind[];
  readonly currencySubtotals: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A real calendar day inside ClickHouse's Date range (1970-01-01..2149-06-06):
 * toDate saturates an invalid or out-of-range day instead of failing.
 */
const isCalendarDay = (value: string): boolean => {
  if (!DAY.test(value) || value < '1970-01-01' || value > '2149-06-06') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const CODE = /^\d{1,10}$/u;

const listOf = <T extends string>(
  values: readonly string[] | null | undefined,
  allowed: readonly T[],
  field: string
): Result<readonly T[] | null, ApiError> => {
  if (values === null || values === undefined) return ok(null);
  if (values.length === 0) return err(invalidInput(`${field} must not be empty`, field));
  const unknown = values.find((v) => !(allowed as readonly string[]).includes(v));
  if (unknown !== undefined) return err(invalidInput(`unknown ${field} '${unknown}'`, field));
  // Sorted: equal filter sets give equal echoes and share one read.
  return ok([...new Set(values)].sort() as T[]);
};

const textOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
};

/** Validate one request and apply the owner's defaults (20 Nov 2026). */
export const parseTotalsRequest = (input: TotalsRequestInput): Result<TotalsRequest, ApiError> => {
  const f = input.filters ?? {};
  const kinds = listOf(f.procurementKinds, PROCUREMENT_KINDS, 'procurementKinds');
  if (kinds.isErr()) return err(kinds.error);
  // Kinds of procurement are never mixed by default: the client names them.
  if (kinds.value === null) {
    return err(invalidInput('procurementKinds is required', 'procurementKinds'));
  }
  const contractKinds = listOf(f.contractKinds, CONTRACT_KINDS, 'contractKinds');
  if (contractKinds.isErr()) return err(contractKinds.error);
  const statuses = listOf(f.statuses, STATUSES, 'statuses');
  if (statuses.isErr()) return err(statuses.error);
  const vatBases = listOf(f.vatBases, VAT_BASES, 'vatBases');
  if (vatBases.isErr()) return err(vatBases.error);
  const valueKinds = listOf(input.valueKinds, VALUE_KINDS, 'valueKinds');
  if (valueKinds.isErr()) return err(valueKinds.error);

  const from = textOrNull(f.from);
  const to = textOrNull(f.to);
  if (from !== null && !isCalendarDay(from)) {
    return err(invalidInput('from must be a calendar day, YYYY-MM-DD', 'from'));
  }
  if (to !== null && !isCalendarDay(to)) {
    return err(invalidInput('to must be a calendar day, YYYY-MM-DD', 'to'));
  }
  if (from !== null && to !== null && from > to) {
    return err(invalidInput('from must not be after to', 'from'));
  }
  const codes = {
    buyerCode: textOrNull(f.buyerCode),
    supplierCode: textOrNull(f.supplierCode),
    countyCode: textOrNull(f.countyCode),
    siruta: textOrNull(f.siruta),
  };
  for (const field of ['buyerCode', 'supplierCode'] as const) {
    const code = codes[field];
    if (code !== null && !CODE.test(code)) {
      return err(invalidInput(`${field} must be a fiscal code (digits)`, field));
    }
  }
  if (codes.siruta !== null && !/^\d{1,7}$/u.test(codes.siruta)) {
    return err(invalidInput('siruta must be digits', 'siruta'));
  }
  if (codes.countyCode !== null && !/^[A-Z]{1,2}$/u.test(codes.countyCode)) {
    return err(invalidInput('countyCode must be a county code (e.g. CJ, B)', 'countyCode'));
  }
  const cpvPrefix = textOrNull(f.cpvPrefix);
  if (cpvPrefix !== null && !/^\d{2,8}$/u.test(cpvPrefix)) {
    return err(invalidInput('cpvPrefix must be 2–8 digits', 'cpvPrefix'));
  }
  const q = textOrNull(f.q);
  if (q !== null && (q.length < 3 || q.length > 100)) {
    return err(invalidInput('q must be 3–100 characters', 'q'));
  }
  return ok({
    id: input.id,
    filters: {
      procurementKinds: kinds.value,
      contractKinds: contractKinds.value,
      // Owner default: awarded only.
      statuses: statuses.value ?? ['awarded'],
      from,
      to,
      ...codes,
      cpvPrefix,
      vatBases: vatBases.value,
      q,
    },
    valueKinds: valueKinds.value ?? ['awarded'],
    currencySubtotals: input.currencySubtotals === true,
  });
};

/**
 * One aggregate row: the facts sharing every dimension a decision needs. The
 * shell groups by exactly these columns, under the request's non-status
 * filters (procurement kinds, contract kinds, place, CPV, buyer, supplier,
 * VAT basis, q) and with the date range widened to admit undated rows.
 */
export interface FactAggregate {
  readonly valueKind: ValueKind;
  readonly status: FactStatus;
  readonly additive: boolean;
  /** award_day is not null. */
  readonly dated: boolean;
  /** award_day lies in the requested range (true when no range was asked). */
  readonly inRange: boolean;
  /** amount_bani is not null. */
  readonly hasAmount: boolean;
  readonly jointWin: boolean;
  readonly vatBasis: VatBasis;
  readonly currency: string | null;
  readonly unverifiedHead: boolean;
  readonly listValue: boolean;
  /** supplier_ref = '0': the supplier is withheld under D6 (its money still counts). */
  readonly withheldSupplier: boolean;
  readonly count: bigint;
  /** Σ amount_bani over the rows that have one. */
  readonly sumBani: bigint;
  /** Σ native_amount in minor units (scale 2), for currency subtotals. */
  readonly nativeSumMinor: bigint;
}

/** One label row (procurement_v3.money_labels). */
export interface MoneyLabel {
  readonly labelSet: string;
  readonly key: string;
  readonly labelRo: string;
  readonly labelEn: string;
  readonly meaningRo: string;
  readonly meaningEn: string;
}

export interface Labelled {
  readonly key: string;
  readonly labelRo: string;
  readonly labelEn: string;
  readonly meaningRo: string | null;
  readonly meaningEn: string | null;
}

export interface TotalFigure {
  readonly valueKind: ValueKind;
  readonly sumLei: string;
  readonly recordCount: string;
  readonly withValueCount: string;
  readonly vatMix: {
    readonly excluded: string;
    readonly included: string;
    readonly unknown: string;
  };
  readonly currencies:
    | readonly {
        readonly currency: string;
        readonly sum: string;
        readonly count: string;
      }[]
    | null;
}

export interface Exclusion extends Labelled {
  readonly valueKind: ValueKind;
  readonly count: string;
  /** Null when none of the excluded rows has a lei amount. */
  readonly valueLei: string | null;
}

export interface Flag extends Labelled {
  readonly valueKind: ValueKind;
  readonly count: string;
}

/** Included, but disclosed: e.g. records whose supplier is withheld under D6. */
export interface Disclosure extends Labelled {
  readonly valueKind: ValueKind;
  readonly count: string;
  readonly valueLei: string;
}

/** A note on the request itself, with no count (a count would say more than the rule allows). */
export type TotalsNote = Labelled;

export interface TotalsAnswer {
  readonly id: string;
  readonly factBuild: string;
  /**
   * The D6 state the answer was served under: `off`, `unavailable` (no
   * publication readable: never cache), or the supplier_privacy publication.
   * Clients key caches by (factBuild, disclosureKey).
   */
  readonly disclosureKey: string;
  /** What these filters may sum: the additive value kinds of the asked procurement kinds. */
  readonly allowed: { readonly valueKinds: readonly ValueKind[] };
  readonly filtersApplied: TotalsFilters;
  readonly valueKinds: readonly ValueKind[];
  readonly included: {
    readonly procurementKinds: readonly Labelled[];
    readonly statuses: readonly Labelled[];
    readonly valueKinds: readonly Labelled[];
  };
  readonly totals: readonly TotalFigure[];
  readonly exclusions: readonly Exclusion[];
  readonly flags: readonly Flag[];
  readonly disclosures: readonly Disclosure[];
  readonly notes: readonly TotalsNote[];
  readonly explanation: { readonly textRo: string; readonly textEn: string };
  /** Population per value kind (count), for the invariant and the client. */
  readonly population: readonly { readonly valueKind: ValueKind; readonly count: string }[];
}

/**
 * The value kinds that are summed for each procurement kind (schema draft 2,
 * "How each kind of procurement fills it"): everything else is display only.
 */
const SUMMABLE_VALUE_KINDS: Readonly<Record<ProcurementKind, readonly ValueKind[]>> = {
  direct_acquisition: ['awarded'],
  contract_award: ['awarded', 'framework_ceiling', 'modification_change'],
  market_consultation: [],
  advertising_notice: [],
  direct_award_notification: [],
};

/** Integer bani → lei decimal string (exact). */
export const baniToLei = (bani: bigint): string => {
  const sign = bani < 0n ? '-' : '';
  const abs = bani < 0n ? -bani : bani;
  return `${sign}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
};

/**
 * Why a fact of a requested value kind is left out, or null when it counts.
 * One reason per fact, in a fixed order, so the exclusions partition the
 * population and the invariant holds.
 */
export const exclusionOf = (
  fact: Pick<FactAggregate, 'status' | 'additive' | 'hasAmount' | 'dated' | 'inRange' | 'jointWin'>,
  request: Pick<TotalsRequest, 'filters'>
): ExclusionKey | null => {
  const { statuses, supplierCode, from, to } = request.filters;
  // A status the request does not ask for is excluded under its own key; a
  // requested status whose fact is not additive is `not_additive` (listed,
  // never summed) — procurement-prod, 20 Nov.
  if (!statuses.includes(fact.status)) {
    return fact.status === 'identity_review' ? 'identity_review' : `status:${fact.status}`;
  }
  if (!fact.additive) return 'not_additive';
  if (!fact.hasAmount) return 'no_value';
  if (from !== null || to !== null) {
    if (!fact.dated) return 'undated';
    // A dated fact outside the range is not in the population at all: the
    // shell never reads it. Kept here as defence in depth.
    if (!fact.inRange) return 'undated';
  }
  // A firm's own sum leaves joint wins out until the split rule exists (PROC-4JSX).
  if (supplierCode !== null && fact.jointWin) return 'association_unattributed';
  return null;
};

const labelFor = (
  labels: ReadonlyMap<string, MoneyLabel>,
  labelSet: string,
  key: string
): Labelled => {
  const found = labels.get(`${labelSet}:${key}`);
  // A missing label is shown as its key: never a guessed text.
  return {
    key,
    labelRo: found?.labelRo ?? key,
    labelEn: found?.labelEn ?? key,
    meaningRo: found?.meaningRo ?? null,
    meaningEn: found?.meaningEn ?? null,
  };
};

const exclusionLabel = (labels: ReadonlyMap<string, MoneyLabel>, key: ExclusionKey): Labelled =>
  key.startsWith('status:')
    ? { ...labelFor(labels, 'status', key.slice('status:'.length)), key }
    : labelFor(labels, 'exclusion', key);

const joinList = (items: readonly string[], and: string): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1) ?? ''}`;

/** Fold the aggregate into the answer for one request. */
export const composeTotals = (
  request: TotalsRequest,
  aggregate: readonly FactAggregate[],
  labelRows: readonly MoneyLabel[],
  factBuild: string,
  options: {
    /**
     * The supplier filter names a code that is not public (D6): nothing is read
     * and nothing is counted. The answer says so without any count, and never
     * echoes the code.
     */
    readonly supplierWithheld?: boolean;
    readonly disclosureKey?: string;
  } = {}
): TotalsAnswer => {
  const supplierWithheld = options.supplierWithheld === true;
  const labels = new Map(labelRows.map((l) => [`${l.labelSet}:${l.key}`, l]));
  const totals: TotalFigure[] = [];
  const exclusions: Exclusion[] = [];
  const flags: Flag[] = [];
  const disclosures: Disclosure[] = [];
  const notes: TotalsNote[] = supplierWithheld
    ? [labelFor(labels, 'exclusion', 'withheld_d6')]
    : [];
  const facts = supplierWithheld ? [] : aggregate;
  const population: { valueKind: ValueKind; count: string }[] = [];

  for (const valueKind of request.valueKinds) {
    const rows = facts.filter((row) => row.valueKind === valueKind);
    let count = 0n;
    let withValue = 0n;
    let sum = 0n;
    let popCount = 0n;
    const vat = { excluded: 0n, included: 0n, unknown: 0n };
    const currencies = new Map<string, { sum: bigint; count: bigint }>();
    const excluded = new Map<ExclusionKey, { count: bigint; sum: bigint; valued: boolean }>();
    let unverified = 0n;
    let listValue = 0n;
    let withheldCount = 0n;
    let withheldSum = 0n;
    for (const row of rows) {
      popCount += row.count;
      const reason = exclusionOf(row, request);
      if (reason !== null) {
        const prior = excluded.get(reason) ?? { count: 0n, sum: 0n, valued: false };
        excluded.set(reason, {
          count: prior.count + row.count,
          sum: prior.sum + row.sumBani,
          valued: prior.valued || row.hasAmount,
        });
        continue;
      }
      count += row.count;
      withValue += row.count; // included rows all have an amount (no_value is excluded)
      sum += row.sumBani;
      vat[row.vatBasis] += row.count;
      if (row.unverifiedHead) unverified += row.count;
      if (row.listValue) listValue += row.count;
      if (row.withheldSupplier) {
        withheldCount += row.count;
        withheldSum += row.sumBani;
      }
      if (request.currencySubtotals && row.currency !== null) {
        const prior = currencies.get(row.currency) ?? { sum: 0n, count: 0n };
        currencies.set(row.currency, {
          sum: prior.sum + row.nativeSumMinor,
          count: prior.count + row.count,
        });
      }
    }
    population.push({ valueKind, count: popCount.toString() });
    totals.push({
      valueKind,
      sumLei: baniToLei(sum),
      recordCount: count.toString(),
      withValueCount: withValue.toString(),
      vatMix: {
        excluded: vat.excluded.toString(),
        included: vat.included.toString(),
        unknown: vat.unknown.toString(),
      },
      currencies: request.currencySubtotals
        ? [...currencies.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([currency, v]) => ({
              currency,
              sum: baniToLei(v.sum),
              count: v.count.toString(),
            }))
        : null,
    });
    for (const [key, v] of [...excluded.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      exclusions.push({
        ...exclusionLabel(labels, key),
        valueKind,
        count: v.count.toString(),
        valueLei: v.valued ? baniToLei(v.sum) : null,
      });
    }
    if (unverified > 0n) {
      flags.push({
        ...labelFor(labels, 'ca_head_status', 'unverified'),
        valueKind,
        count: unverified.toString(),
      });
    }
    if (withheldCount > 0n) {
      disclosures.push({
        ...labelFor(labels, 'disclosure', 'withheld_supplier'),
        valueKind,
        count: withheldCount.toString(),
        valueLei: baniToLei(withheldSum),
      });
    }
    if (listValue > 0n) {
      flags.push({
        ...labelFor(labels, 'flag', 'list_value'),
        valueKind,
        count: listValue.toString(),
      });
    }
  }

  const f: TotalsFilters = supplierWithheld
    ? { ...request.filters, supplierCode: null }
    : request.filters;
  const included = {
    procurementKinds: f.procurementKinds.map((k) => labelFor(labels, 'procurement_kind', k)),
    statuses: f.statuses.map((s) => labelFor(labels, 'status', s)),
    valueKinds: request.valueKinds.map((v) => labelFor(labels, 'value_kind', v)),
  };
  const allowed = [
    ...new Set(f.procurementKinds.flatMap((kind) => SUMMABLE_VALUE_KINDS[kind])),
  ].sort();
  return {
    id: request.id,
    factBuild,
    disclosureKey: options.disclosureKey ?? 'off',
    allowed: { valueKinds: allowed },
    filtersApplied: f,
    valueKinds: request.valueKinds,
    included,
    totals,
    exclusions,
    flags,
    disclosures,
    notes,
    explanation: explain(request, included, exclusions, flags, disclosures, notes),
    population,
  };
};

/** The explanation, composed only from what was applied and counted. */
const explain = (
  request: TotalsRequest,
  included: TotalsAnswer['included'],
  exclusions: readonly Exclusion[],
  flags: readonly Flag[],
  disclosures: readonly Disclosure[],
  notes: readonly TotalsNote[]
): { textRo: string; textEn: string } => {
  const f = request.filters;
  const ro: string[] = [];
  const en: string[] = [];
  ro.push(
    `Include: ${joinList(
      included.procurementKinds.map((l) => l.labelRo),
      'și'
    )}; stare: ${joinList(
      included.statuses.map((l) => l.labelRo),
      'și'
    )}; tip de valoare: ${joinList(
      included.valueKinds.map((l) => l.labelRo),
      'și'
    )}.`
  );
  en.push(
    `Includes: ${joinList(
      included.procurementKinds.map((l) => l.labelEn),
      'and'
    )}; status: ${joinList(
      included.statuses.map((l) => l.labelEn),
      'and'
    )}; value kind: ${joinList(
      included.valueKinds.map((l) => l.labelEn),
      'and'
    )}.`
  );
  if (f.from !== null || f.to !== null) {
    ro.push(`Perioada: ${f.from ?? '…'} – ${f.to ?? '…'}.`);
    en.push(`Period: ${f.from ?? '…'} – ${f.to ?? '…'}.`);
  }
  ro.push('Valorile sunt adunate așa cum au fost publicate (fără conversie TVA), în lei.');
  en.push('Values are summed as published (no VAT conversion), in lei.');
  if (exclusions.length > 0) {
    ro.push(
      `Excluse: ${exclusions.map((e) => `${e.labelRo} (${e.count}${e.valueLei === null ? '' : `, ${e.valueLei} lei`})`).join('; ')}.`
    );
    en.push(
      `Left out: ${exclusions.map((e) => `${e.labelEn} (${e.count}${e.valueLei === null ? '' : `, ${e.valueLei} lei`})`).join('; ')}.`
    );
  }
  if (flags.length > 0) {
    ro.push(`Incluse, marcate: ${flags.map((g) => `${g.labelRo} (${g.count})`).join('; ')}.`);
    en.push(`Included, flagged: ${flags.map((g) => `${g.labelEn} (${g.count})`).join('; ')}.`);
  }
  if (disclosures.length > 0) {
    ro.push(
      `Include: ${disclosures.map((d) => `${d.labelRo} (${d.count}, ${d.valueLei} lei)`).join('; ')}.`
    );
    en.push(
      `Includes: ${disclosures.map((d) => `${d.labelEn} (${d.count}, ${d.valueLei} lei)`).join('; ')}.`
    );
  }
  if (notes.length > 0) {
    ro.push(`${notes.map((n) => n.labelRo).join('; ')}.`);
    en.push(`${notes.map((n) => n.labelEn).join('; ')}.`);
  }
  return { textRo: ro.join(' '), textEn: en.join(' ') };
};

// ── port and use case ────────────────────────────────────────────────────────

/** The filters one aggregate read depends on (status and value kind are folded later). */
export type AggregateFilters = Omit<TotalsFilters, 'statuses'>;

export interface MoneyTotalsPort {
  /** The active money build (procurement_v3.money_generations); null when none is published. */
  activeBuild(): Promise<Result<string | null, ApiError>>;
  labels(build: string): Promise<Result<readonly MoneyLabel[], ApiError>>;
  /** The public supplier ref for a fiscal code in this build; null when the code is not public. */
  supplierRef(build: string, supplierCode: string): Promise<Result<string | null, ApiError>>;
  aggregate(
    build: string,
    filters: AggregateFilters,
    supplierRef: string | null,
    valueKinds: readonly ValueKind[]
  ): Promise<Result<readonly FactAggregate[], ApiError>>;
}

/** The non-status filters: what one aggregate read depends on. */
const aggregateFiltersOf = (f: TotalsFilters): AggregateFilters => ({
  procurementKinds: f.procurementKinds,
  contractKinds: f.contractKinds,
  from: f.from,
  to: f.to,
  buyerCode: f.buyerCode,
  supplierCode: f.supplierCode,
  cpvPrefix: f.cpvPrefix,
  countyCode: f.countyCode,
  siruta: f.siruta,
  vatBases: f.vatBases,
  q: f.q,
});

const aggregateKey = (f: TotalsFilters): string => JSON.stringify(aggregateFiltersOf(f));

/**
 * Answer a batch of totals requests against ONE money build: every request is
 * read under the same build, and requests sharing their non-status filters
 * share one aggregate read (the value kinds of all of them).
 */
export const moneyTotals = async (
  port: MoneyTotalsPort,
  inputs: readonly TotalsRequestInput[],
  /** Site-wide D6; absent or not enforced means the build's supplier map alone decides. */
  disclosure?: SupplierDisclosurePort
): Promise<Result<readonly TotalsAnswer[], ApiError>> => {
  if (inputs.length === 0) return err(invalidInput('requests must not be empty', 'requests'));
  if (inputs.length > MAX_TOTALS_REQUESTS) {
    return err(
      invalidInput(`at most ${String(MAX_TOTALS_REQUESTS)} requests per call`, 'requests')
    );
  }
  const requests: TotalsRequest[] = [];
  for (const input of inputs) {
    const parsed = parseTotalsRequest(input);
    if (parsed.isErr()) return err(parsed.error);
    requests.push(parsed.value);
  }
  const build = await port.activeBuild();
  if (build.isErr()) return err(build.error);
  if (build.value === null) {
    return err(serviceUnavailable('procurement totals are not published yet'));
  }
  const factBuild = build.value;
  const labels = await port.labels(factBuild);
  if (labels.isErr()) return err(labels.error);

  // D6 now, not only as of the build: a supplier withheld since the build was
  // published must not be filterable (its money would name it).
  const d6 = disclosure?.enforced === true ? disclosure : undefined;
  let disclosureKey = 'off';
  let publicCodes: ReadonlySet<string> | null = null;
  if (d6 !== undefined) {
    const codes = await d6.publicSupplierCodes();
    if (codes.isErr()) return err(codes.error);
    publicCodes = codes.value;
    disclosureKey = disclosureKeyOf(codes.value);
  }

  // One read per distinct non-status filter set, for the union of its value kinds.
  const groups = new Map<string, { filters: TotalsFilters; kinds: Set<ValueKind> }>();
  for (const request of requests) {
    const key = aggregateKey(request.filters);
    const group = groups.get(key) ?? { filters: request.filters, kinds: new Set<ValueKind>() };
    for (const kind of request.valueKinds) group.kinds.add(kind);
    groups.set(key, group);
  }
  const reads = await Promise.all(
    [...groups.entries()].map(async ([key, group]) => {
      const filters = aggregateFiltersOf(group.filters);
      let ref: string | null = null;
      if (filters.supplierCode !== null) {
        if (publicCodes !== null && !publicCodes.has(filters.supplierCode)) {
          return [key, ok({ rows: [], withheld: true, supplierRead: false })] as const;
        }
        const found = await port.supplierRef(factBuild, filters.supplierCode);
        if (found.isErr()) return [key, err(found.error)] as const;
        // Not public (D6) in this build: nothing is read, nothing is counted.
        if (found.value === null)
          return [key, ok({ rows: [], withheld: true, supplierRead: false })] as const;
        ref = found.value;
      }
      const rows = await port.aggregate(factBuild, filters, ref, [...group.kinds]);
      return [
        key,
        rows.map((value) => ({ rows: value, withheld: false, supplierRead: ref !== null })),
      ] as const;
    })
  );
  const byKey = new Map<string, { rows: readonly FactAggregate[]; withheld: boolean }>();
  let readASupplier = false;
  for (const [key, read] of reads) {
    if (read.isErr()) return err(read.error);
    byKey.set(key, read.value);
    if (read.value.supplierRead) readASupplier = true;
  }
  // A publish during the request that withheld a filtered supplier: repeat, as
  // the analysis API does, so every answer is decided under its key.
  if (d6 !== undefined && readASupplier) {
    const fresh = await d6.publicSupplierCodes({ fresh: true });
    if (fresh.isErr()) return err(fresh.error);
    if (disclosureKeyOf(fresh.value) !== disclosureKey) {
      return err(
        serviceUnavailable(
          'the supplier privacy list was republished during this request; repeat the request'
        )
      );
    }
  }
  return ok(
    requests.map((request) => {
      const read = byKey.get(aggregateKey(request.filters)) ?? { rows: [], withheld: false };
      return composeTotals(request, read.rows, labels.value, factBuild, {
        supplierWithheld: read.withheld,
        disclosureKey,
      });
    })
  );
};
