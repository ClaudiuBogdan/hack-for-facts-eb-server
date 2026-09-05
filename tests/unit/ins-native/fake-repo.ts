/**
 * An in-memory `InsRepo` that simulates the phase-A Chronos tables for the
 * usecase and resolver tests. It models the spine (RO > RO1 > RO11 > CJ > Cluj-Napoca,
 * plus AB > Alba Iulia), two datasets:
 *  - POP107D-like `POPTEST`: dims 0 age (TOTAL + 2), 1 sex (TOTAL + 2), 2 county
 *    (TOTAL member + CJ + AB), 3 locality (TOTAL member + Cluj-Napoca + Alba Iulia),
 *    time, unit (single);
 *  - county-only `CNTTEST` (mat_reg_j-style): dims 0 territory (TOTAL + region
 *    RO11 + county CJ), time, unit (two units, no default unit).
 * Facts are generated so every (territory, year) has a known value, which lets a
 * test assert exactly which rows a resolved query returns.
 */

import { ok, type Result } from 'neverthrow';

import {
  type InsContext,
  type InsDatasetView,
  type InsDimensionView,
  type InsFactQuery,
  type InsMemberView,
  type InsObservationView,
  type InsGeoPairs,
  type InsPage,
  type InsPeriodView,
  type InsTerritoryLevel,
  type InsTerritoryNode,
  type InsUnitView,
  type SlotPins,
} from '@/modules/ins-native/core/types.js';

import type {
  InsDefaultPin,
  InsRepo,
  InsSeriesRow,
  InsTerritoryBinding,
  InsTerritoryDimension,
} from '@/modules/ins-native/core/ports.js';
import type { ApiError } from '@/modules/shared/index.js';

const node = (
  id: number,
  code: string,
  level: InsTerritoryLevel,
  nameRo: string,
  parent: InsTerritoryNode | null,
  siruta: string | null = null
): InsTerritoryNode => ({
  territoryId: id,
  code,
  sirutaCode: siruta,
  level,
  nameRo,
  parentId: parent?.territoryId ?? null,
  parentCode: parent?.code ?? null,
  parentNameRo: parent?.nameRo ?? null,
  coreTerritoryId: null,
});

export const RO = node(1, 'RO', 'NATIONAL', 'TOTAL', null);
export const RO1 = node(2, 'RO1', 'NUTS1', 'MACROREGIUNEA UNU', RO);
export const RO11 = node(6, 'RO11', 'NUTS2', 'Nord-Vest', RO1);
export const CJ = node(25, 'CJ', 'NUTS3', 'Cluj', RO11);
export const AB = node(14, 'AB', 'NUTS3', 'Alba', RO11);
export const CLUJ_NAPOCA = node(931, '54975', 'LAU', 'MUNICIPIUL CLUJ-NAPOCA', CJ, '54975');
export const ALBA_IULIA = node(56, '1017', 'LAU', 'MUNICIPIUL ALBA IULIA', AB, '1017');
export const NODES = [RO, RO1, RO11, CJ, AB, CLUJ_NAPOCA, ALBA_IULIA];

const dataset = (code: string, k: number, hasLau: boolean, hasCounty: boolean): InsDatasetView => ({
  code,
  nameRo: `Matricea ${code}`,
  nameEn: `Matrix ${code}`,
  definitionRo: null,
  definitionEn: null,
  methodologyRo: null,
  dataSourcesRo: null,
  periodicities: ['ANNUAL'],
  yearRange: [2019, 2021],
  sourceYearRange: [1992, 2025],
  dimensionCount: k + 2,
  classificationDimCount: k,
  timeDimIndex: k,
  unitDimIndex: k + 1,
  hasLau,
  hasCounty,
  hasRegion: !hasLau,
  hasNational: true,
  dataStatus: 'AVAILABLE',
  publicationStatus: 'READY',
  observationCount: 100,
  computedAt: '2026-09-02T10:00:00+00',
  sourceLastUpdate: '2026-08-04',
  contextCode: '1',
  contextNameRo: 'A. STATISTICA SOCIALA',
  contextNameEn: 'A. SOCIAL STATISTICS',
  contextPath: 'A. STATISTICA SOCIALA > POPULATIE',
  custodySha256: 'a'.repeat(64),
  revisionId: '1',
  transformContractSha256: 'b'.repeat(64),
  publishedAt: '2026-09-02T10:00:00+00',
  sourceUrl: `http://statistici.insse.ro:8077/tempo-ins/matrix/${code}?lang=ro`,
});

export const POPTEST = dataset('POPTEST', 4, true, true);
export const CNTTEST = dataset('CNTTEST', 1, false, true);
export const CATALOG_ONLY = {
  ...dataset('EMPTYTEST', 1, false, false),
  dataStatus: 'CATALOG_ONLY' as const,
  publicationStatus: 'NOT_LOADED' as const,
  observationCount: null,
  custodySha256: null,
  revisionId: null,
  transformContractSha256: null,
  publishedAt: null,
  computedAt: null,
  yearRange: null,
};

const dim = (
  datasetCode: string,
  dimIndex: number,
  slotIndex: number | null,
  role: InsDimensionView['role'],
  labelRo: string,
  optionCount: number,
  isTerritorial = false
): InsDimensionView => ({
  datasetCode,
  dimIndex,
  slotIndex,
  role,
  labelRo,
  labelEn: null,
  optionCount,
  parentDimIndex: null,
  isTerritorial,
});

export const DIMENSIONS: Record<string, InsDimensionView[]> = {
  POPTEST: [
    dim('POPTEST', 0, 1, 'classification', 'Varste si grupe de varsta', 3),
    dim('POPTEST', 1, 2, 'classification', 'Sexe', 3),
    dim('POPTEST', 2, 3, 'classification', 'Judete', 3, true),
    dim('POPTEST', 3, 4, 'classification', 'Localitati', 3, true),
    dim('POPTEST', 4, null, 'time', 'Ani', 3),
    dim('POPTEST', 5, null, 'unit', 'UM: Numar persoane', 1),
  ],
  CNTTEST: [
    dim(
      'CNTTEST',
      0,
      1,
      'classification',
      'Macroregiuni, regiuni de dezvoltare si judete',
      3,
      true
    ),
    dim('CNTTEST', 1, null, 'time', 'Ani', 3),
    dim('CNTTEST', 2, null, 'unit', 'UM', 2),
  ],
  EMPTYTEST: [
    dim('EMPTYTEST', 0, 1, 'classification', 'Tipuri', 2),
    dim('EMPTYTEST', 1, null, 'time', 'Ani', 1),
    dim('EMPTYTEST', 2, null, 'unit', 'UM', 1),
  ],
};

interface MemberSeed {
  dataset: string;
  dim: number;
  id: number;
  label: string;
  role: InsMemberView['memberRole'];
  node?: InsTerritoryNode;
  total?: boolean;
}

const M: MemberSeed[] = [
  // POPTEST age
  { dataset: 'POPTEST', dim: 0, id: 1, label: 'Total', role: 'TOTAL' },
  { dataset: 'POPTEST', dim: 0, id: 2, label: '0-4 ani', role: 'LEAF' },
  { dataset: 'POPTEST', dim: 0, id: 3, label: '5-9 ani', role: 'LEAF' },
  // POPTEST sex
  { dataset: 'POPTEST', dim: 1, id: 105, label: 'Total', role: 'TOTAL' },
  { dataset: 'POPTEST', dim: 1, id: 106, label: 'Masculin', role: 'LEAF' },
  { dataset: 'POPTEST', dim: 1, id: 107, label: 'Feminin', role: 'LEAF' },
  // POPTEST county (TOTAL member = the national row of this dimension)
  { dataset: 'POPTEST', dim: 2, id: 3064, label: 'TOTAL', role: 'TOTAL', total: true },
  { dataset: 'POPTEST', dim: 2, id: 3075, label: 'Cluj', role: 'LEAF', node: CJ },
  { dataset: 'POPTEST', dim: 2, id: 3065, label: 'Alba', role: 'LEAF', node: AB },
  // POPTEST locality
  { dataset: 'POPTEST', dim: 3, id: 112, label: 'TOTAL', role: 'TOTAL', total: true },
  {
    dataset: 'POPTEST',
    dim: 3,
    id: 931,
    label: '54975 MUNICIPIUL CLUJ-NAPOCA',
    role: 'LEAF',
    node: CLUJ_NAPOCA,
  },
  {
    dataset: 'POPTEST',
    dim: 3,
    id: 113,
    label: '1017 MUNICIPIUL ALBA IULIA',
    role: 'LEAF',
    node: ALBA_IULIA,
  },
  // POPTEST time + unit
  { dataset: 'POPTEST', dim: 4, id: 4399, label: 'Anul 2019', role: 'UNKNOWN' },
  { dataset: 'POPTEST', dim: 4, id: 4418, label: 'Anul 2020', role: 'UNKNOWN' },
  { dataset: 'POPTEST', dim: 4, id: 4437, label: 'Anul 2021', role: 'UNKNOWN' },
  { dataset: 'POPTEST', dim: 5, id: 9685, label: 'Numar persoane', role: 'UNKNOWN' },
  // CNTTEST territory dim (reg-j style): TOTAL, region, county
  { dataset: 'CNTTEST', dim: 0, id: 8000, label: 'TOTAL', role: 'TOTAL', total: true },
  { dataset: 'CNTTEST', dim: 0, id: 8001, label: 'Regiunea NORD-VEST', role: 'LEAF', node: RO11 },
  { dataset: 'CNTTEST', dim: 0, id: 8002, label: 'Cluj', role: 'LEAF', node: CJ },
  { dataset: 'CNTTEST', dim: 1, id: 4399, label: 'Anul 2019', role: 'UNKNOWN' },
  { dataset: 'CNTTEST', dim: 1, id: 4418, label: 'Anul 2020', role: 'UNKNOWN' },
  { dataset: 'CNTTEST', dim: 2, id: 9507, label: 'Lei', role: 'UNKNOWN' },
  { dataset: 'CNTTEST', dim: 2, id: 9508, label: 'Euro', role: 'UNKNOWN' },
  // EMPTYTEST (catalog only, no TOTAL on its classification dim)
  { dataset: 'EMPTYTEST', dim: 0, id: 7001, label: 'Tip A', role: 'LEAF' },
  { dataset: 'EMPTYTEST', dim: 0, id: 7002, label: 'Tip B', role: 'LEAF' },
  { dataset: 'EMPTYTEST', dim: 1, id: 4399, label: 'Anul 2019', role: 'UNKNOWN' },
  { dataset: 'EMPTYTEST', dim: 2, id: 9685, label: 'Numar', role: 'UNKNOWN' },
];

const toMember = (m: MemberSeed): InsMemberView => ({
  datasetCode: m.dataset,
  dimIndex: m.dim,
  dimLabelRo: (DIMENSIONS[m.dataset] ?? []).find((d) => d.dimIndex === m.dim)?.labelRo ?? '',
  dimLabelEn: null,
  nomItemId: m.id,
  ordinal: m.id,
  labelRo: m.label,
  labelEn: null,
  memberRole: m.role,
  parentNomItemId: null,
  territory: m.node ?? null,
  territoryResolution: m.node !== undefined ? 'RESOLVED' : m.total === true ? 'TOTAL_MEMBER' : null,
});

const UNITS: Record<string, InsUnitView[]> = {
  POPTEST: [
    {
      nomItemId: 9685,
      labelRo: 'Numar persoane',
      labelEn: 'Number of persons',
      baseUnit: 'persons',
      scaleFactor: '1',
      unitKind: 'non-monetary',
      currencyRegime: null,
    },
  ],
  CNTTEST: [
    {
      nomItemId: 9507,
      labelRo: 'Lei',
      labelEn: 'Lei',
      baseUnit: 'currency',
      scaleFactor: '1',
      unitKind: 'monetary',
      currencyRegime: 'RON',
    },
    {
      nomItemId: 9508,
      labelRo: 'Euro',
      labelEn: 'Euro',
      baseUnit: 'currency',
      scaleFactor: '1',
      unitKind: 'monetary',
      currencyRegime: 'EUR',
    },
  ],
  EMPTYTEST: [
    {
      nomItemId: 9685,
      labelRo: 'Numar',
      labelEn: null,
      baseUnit: null,
      scaleFactor: '1',
      unitKind: 'non-monetary',
      currencyRegime: null,
    },
  ],
};

const PERIODS: InsPeriodView[] = [
  {
    periodId: 28,
    periodicity: 'ANNUAL',
    periodStart: '2019-01-01',
    periodEnd: '2019-12-31',
    labelRo: 'Anul 2019',
  },
  {
    periodId: 29,
    periodicity: 'ANNUAL',
    periodStart: '2020-01-01',
    periodEnd: '2020-12-31',
    labelRo: 'Anul 2020',
  },
  {
    periodId: 30,
    periodicity: 'ANNUAL',
    periodStart: '2021-01-01',
    periodEnd: '2021-12-31',
    labelRo: 'Anul 2021',
  },
];
const TIME_TO_PERIOD = new Map([
  [4399, PERIODS[0]],
  [4418, PERIODS[1]],
  [4437, PERIODS[2]],
]);

/** Default pins as the loader would write them: TOTALs + the single unit. */
const DEFAULTS: InsDefaultPin[] = [
  { datasetCode: 'POPTEST', dimIndex: 0, nomItemId: 1, policy: 'TOTAL_MEMBER' },
  { datasetCode: 'POPTEST', dimIndex: 1, nomItemId: 105, policy: 'TOTAL_MEMBER' },
  { datasetCode: 'POPTEST', dimIndex: 2, nomItemId: 3064, policy: 'TOTAL_MEMBER' },
  { datasetCode: 'POPTEST', dimIndex: 3, nomItemId: 112, policy: 'TOTAL_MEMBER' },
  { datasetCode: 'POPTEST', dimIndex: 5, nomItemId: 9685, policy: 'SINGLE_UNIT' },
  { datasetCode: 'CNTTEST', dimIndex: 0, nomItemId: 8000, policy: 'TOTAL_MEMBER' },
  // CNTTEST has two units and no manifest pin → no default unit → NO_DATA on tiles.
];

interface Fact {
  dataset: string;
  slots: (number | null)[];
  time: number;
  unit: number;
  value: string;
}

/** Deterministic facts: value = `${territoryTag}${year}` so tests can read intent off the value. */
const FACTS: Fact[] = [];
for (const time of [4399, 4418, 4437]) {
  const year = TIME_TO_PERIOD.get(time)?.periodStart.slice(0, 4) ?? '';
  for (const age of [1, 2, 3]) {
    for (const sex of [105, 106, 107]) {
      // national row: county TOTAL + locality TOTAL
      FACTS.push({
        dataset: 'POPTEST',
        slots: [age, sex, 3064, 112, null, null, null],
        time,
        unit: 9685,
        value: `RO-${String(age)}-${String(sex)}-${year}`,
      });
      // county rows: county member + locality TOTAL
      for (const [county, tag] of [
        [3075, 'CJ'],
        [3065, 'AB'],
      ] as const) {
        FACTS.push({
          dataset: 'POPTEST',
          slots: [age, sex, county, 112, null, null, null],
          time,
          unit: 9685,
          value: `${tag}-${String(age)}-${String(sex)}-${year}`,
        });
      }
      // locality rows
      FACTS.push({
        dataset: 'POPTEST',
        slots: [age, sex, 3075, 931, null, null, null],
        time,
        unit: 9685,
        value: `CLJ-${String(age)}-${String(sex)}-${year}`,
      });
      FACTS.push({
        dataset: 'POPTEST',
        slots: [age, sex, 3065, 113, null, null, null],
        time,
        unit: 9685,
        value: `ALB-${String(age)}-${String(sex)}-${year}`,
      });
    }
  }
}
for (const time of [4399, 4418]) {
  const year = TIME_TO_PERIOD.get(time)?.periodStart.slice(0, 4) ?? '';
  for (const unit of [9507, 9508]) {
    FACTS.push({
      dataset: 'CNTTEST',
      slots: [8000, null, null, null, null, null, null],
      time,
      unit,
      value: `RO-${String(unit)}-${year}`,
    });
    FACTS.push({
      dataset: 'CNTTEST',
      slots: [8001, null, null, null, null, null, null],
      time,
      unit,
      value: `RO11-${String(unit)}-${year}`,
    });
    FACTS.push({
      dataset: 'CNTTEST',
      slots: [8002, null, null, null, null, null, null],
      time,
      unit,
      value: `CJ-${String(unit)}-${year}`,
    });
  }
}

const membersOf = (datasetCode: string): InsMemberView[] =>
  M.filter((m) => m.dataset === datasetCode).map(toMember);

const matchesGroup = (f: Fact, pins: SlotPins): boolean =>
  [...pins].every(([slot, ids]) => {
    const value = f.slots[slot - 1] ?? null;
    return value !== null && ids.includes(value);
  });

/** Independent source tuple fixture, identical in shape to the actual PG seed. */
const GEO_TUPLES: Readonly<
  Record<string, readonly { pairs: InsGeoPairs; node: InsTerritoryNode }[]>
> = {
  POPTEST: [
    {
      pairs: [
        [2, 3064],
        [3, 112],
      ],
      node: RO,
    },
    {
      pairs: [
        [2, 3075],
        [3, 112],
      ],
      node: CJ,
    },
    {
      pairs: [
        [2, 3065],
        [3, 112],
      ],
      node: AB,
    },
    {
      pairs: [
        [2, 3075],
        [3, 931],
      ],
      node: CLUJ_NAPOCA,
    },
    {
      pairs: [
        [2, 3065],
        [3, 113],
      ],
      node: ALBA_IULIA,
    },
  ],
  CNTTEST: [
    { pairs: [[0, 8000]], node: RO },
    { pairs: [[0, 8001]], node: RO11 },
    { pairs: [[0, 8002]], node: CJ },
  ],
};

const toObservation = (f: Fact): InsObservationView => {
  const period = TIME_TO_PERIOD.get(f.time);
  if (period === undefined) throw new Error(`no period for time ${String(f.time)}`);
  const dims = DIMENSIONS[f.dataset] ?? [];
  const members: InsMemberView[] = [];
  for (const d of dims) {
    if (d.role !== 'classification' || d.slotIndex === null) continue;
    const id = f.slots[d.slotIndex - 1] ?? null;
    if (id === null) continue;
    const m = M.find((x) => x.dataset === f.dataset && x.dim === d.dimIndex && x.id === id);
    if (m === undefined) continue;
    members.push(toMember(m));
  }
  const pairs: InsGeoPairs = dims
    .filter((d) => d.isTerritorial)
    .map((d) => {
      if (d.slotIndex === null) throw new Error('fixture geographic slot missing');
      const member = f.slots[d.slotIndex - 1];
      if (member === null || member === undefined)
        throw new Error('fixture geographic member missing');
      return [d.dimIndex, member] as const;
    });
  const tuple = (GEO_TUPLES[f.dataset] ?? []).find(
    (t) => JSON.stringify(t.pairs) === JSON.stringify(pairs)
  );
  if (pairs.length > 0 && tuple === undefined) throw new Error('fixture source tuple missing');
  const territory = tuple?.node ?? null;
  const unit = (UNITS[f.dataset] ?? []).find((u) => u.nomItemId === f.unit);
  if (unit === undefined) throw new Error('unit missing');
  return {
    coordinate: {
      datasetCode: f.dataset,
      slots: f.slots,
      timeNomItemId: f.time,
      unitNomItemId: f.unit,
    },
    period,
    value: f.value,
    valueStatus: null,
    currencyCode: unit.currencyRegime,
    members,
    geography:
      tuple === undefined
        ? null
        : {
            pairs: tuple.pairs,
            resolution: 'EXACT',
            flags: [],
            resolvedTerritory: tuple.node,
            contextTerritory: null,
            applicableRules: [],
            qualified: false,
          },
    territory,
    unit,
  };
};

const sortNewest = (a: Fact, b: Fact): number => {
  const pa = TIME_TO_PERIOD.get(a.time)?.periodEnd ?? '';
  const pb = TIME_TO_PERIOD.get(b.time)?.periodEnd ?? '';
  if (pa !== pb) return pa < pb ? 1 : -1;
  for (let i = 0; i < 7; i++) {
    const x = a.slots[i] ?? -1;
    const y = b.slots[i] ?? -1;
    if (x !== y) return x - y;
  }
  return a.unit - b.unit;
};

const page = <T>(rows: T[], total: number, limit: number, offset: number): InsPage<T> => ({
  nodes: rows.slice(offset, offset + limit),
  totalCount: total,
  hasNextPage: offset + limit < total,
  hasPreviousPage: offset > 0,
});

const R = <T>(v: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(v));

/** Every fact query the fake received, for assertions on what the usecases resolved. */
export const makeFakeRepo = (): InsRepo & {
  readonly factQueries: InsFactQuery[];
  readonly seriesReads: string[][];
} => {
  const factQueries: InsFactQuery[] = [];
  const seriesReads: string[][] = [];
  const datasets = [POPTEST, CNTTEST, CATALOG_ONLY];
  const contexts: InsContext[] = [
    {
      code: '1',
      parentCode: null,
      level: 0,
      nameRo: 'A. STATISTICA SOCIALA',
      nameEn: 'A. SOCIAL STATISTICS',
      path: 'A. STATISTICA SOCIALA',
      ordinal: 1,
      datasetCount: 3,
    },
    {
      code: '10',
      parentCode: '1',
      level: 1,
      nameRo: 'POPULATIE',
      nameEn: 'POPULATION',
      path: 'A. STATISTICA SOCIALA > POPULATIE',
      ordinal: 1,
      datasetCount: 3,
    },
  ];
  const repo: InsRepo & { readonly factQueries: InsFactQuery[]; readonly seriesReads: string[][] } =
    {
      factQueries,
      seriesReads,
      withSnapshot: (fn) => fn(repo),
      listDatasets: (filter, limit, offset) => {
        let rows = datasets;
        if (filter.dataStatus === undefined)
          rows = rows.filter((d) => d.dataStatus === 'AVAILABLE');
        else if (filter.dataStatus.length > 0)
          rows = rows.filter((d) => (filter.dataStatus ?? []).includes(d.dataStatus));
        if (filter.codes !== undefined)
          rows = rows.filter((d) => (filter.codes ?? []).includes(d.code));
        if (filter.search !== undefined)
          rows = rows.filter((d) =>
            d.nameRo.toLowerCase().includes(filter.search?.toLowerCase() ?? '')
          );
        if (filter.hasUatData !== undefined)
          rows = rows.filter((d) => d.hasLau === filter.hasUatData);
        if (filter.hasCountyData !== undefined)
          rows = rows.filter((d) => d.hasCounty === filter.hasCountyData);
        return R(page(rows, rows.length, limit, offset));
      },
      getDataset: (code) => R(datasets.find((d) => d.code === code) ?? null),
      getDatasets: (codes) => R(codes.flatMap((c) => datasets.filter((d) => d.code === c))),
      listDimensions: (datasetCode) => R(DIMENSIONS[datasetCode] ?? []),
      listMembers: (datasetCode, dimIndex, search, limit, offset) => {
        let rows = membersOf(datasetCode).filter((m) => m.dimIndex === dimIndex);
        if (search !== undefined)
          rows = rows.filter((m) => m.labelRo.toLowerCase().includes(search.toLowerCase()));
        return R(page(rows, rows.length, limit, offset));
      },
      membersByIds: (datasetCode, ids) =>
        R(membersOf(datasetCode).filter((m) => ids.includes(m.nomItemId))),
      listUnits: (datasetCode) => R(UNITS[datasetCode] ?? []),
      periodsByLabels: (labels) => R(PERIODS.filter((p) => labels.includes(p.labelRo))),
      listContexts: (filter, limit, offset) => {
        let rows = contexts;
        if (filter.level !== undefined) rows = rows.filter((c) => c.level === filter.level);
        if (filter.parentCode !== undefined)
          rows = rows.filter((c) => c.parentCode === filter.parentCode);
        return R(page(rows, rows.length, limit, offset));
      },
      listTerritories: (filter, limit, offset) => {
        let rows = NODES;
        if (filter.levels !== undefined && filter.levels.length > 0)
          rows = rows.filter((n) => (filter.levels ?? []).includes(n.level));
        if (filter.search !== undefined)
          rows = rows.filter((n) =>
            n.nameRo.toLowerCase().includes(filter.search?.toLowerCase() ?? '')
          );
        if (filter.sirutaCodes !== undefined)
          rows = rows.filter(
            (n) => n.sirutaCode !== null && (filter.sirutaCodes ?? []).includes(n.sirutaCode)
          );
        if (filter.parentCode !== undefined)
          rows = rows.filter((n) => n.parentCode === filter.parentCode);
        return R(page(rows, rows.length, limit, offset));
      },
      territoriesByCodes: (codes, levels) =>
        R(
          NODES.filter(
            (n) =>
              codes.map((c) => c.toUpperCase()).includes(n.code) &&
              (levels === undefined || levels.length === 0 || levels.includes(n.level))
          )
        ),
      territoriesBySiruta: (codes) =>
        R(NODES.filter((n) => n.sirutaCode !== null && codes.includes(n.sirutaCode))),
      ancestorsOf: (id) => {
        const out: InsTerritoryNode[] = [];
        let parentId = NODES.find((n) => n.territoryId === id)?.parentId ?? null;
        while (parentId !== null) {
          const parent = NODES.find((n) => n.territoryId === parentId);
          if (parent === undefined) break;
          out.push(parent);
          parentId = parent.parentId;
        }
        return R(out);
      },
      territoryDimensions: (datasetCode) => {
        const dims = DIMENSIONS[datasetCode] ?? [];
        const out: InsTerritoryDimension[] = [];
        for (const d of dims) {
          if (!d.isTerritorial || d.slotIndex === null) continue;
          const members = M.filter((m) => m.dataset === datasetCode && m.dim === d.dimIndex);
          const levels = [
            ...new Set(members.flatMap((m) => (m.node === undefined ? [] : [m.node.level]))),
          ];
          const total = members.find((m) => m.role === 'TOTAL');
          out.push({
            datasetCode,
            dimIndex: d.dimIndex,
            slotIndex: d.slotIndex,
            levels,
            totalNomItemId: total?.id ?? null,
          });
        }
        return R(out);
      },
      territoryBindings: (datasetCode, ids) => {
        const dims = DIMENSIONS[datasetCode] ?? [];
        const out: InsTerritoryBinding[] = [];
        for (const m of M) {
          if (
            m.dataset !== datasetCode ||
            m.node === undefined ||
            !ids.includes(m.node.territoryId)
          )
            continue;
          const d = dims.find((x) => x.dimIndex === m.dim);
          if (d?.isTerritorial !== true || d.slotIndex === null) continue;
          out.push({
            datasetCode,
            dimIndex: m.dim,
            slotIndex: d.slotIndex,
            nomItemId: m.id,
            territoryId: m.node.territoryId,
            territoryLevel: m.node.level,
          });
        }
        return R(out);
      },
      totalMember: (datasetCode, dimIndex) => {
        const totals = M.filter(
          (m) => m.dataset === datasetCode && m.dim === dimIndex && m.role === 'TOTAL'
        );
        return R(totals.length === 1 ? (totals[0]?.id ?? null) : null);
      },
      defaultPins: (codes) => R(DEFAULTS.filter((p) => codes.includes(p.datasetCode))),
      datasetsWithLevel: (level) =>
        R(
          datasets
            .filter((d) => (level === 'LAU' ? d.hasLau : level === 'NUTS3' ? d.hasCounty : true))
            .map((d) => d.code)
        ),
      listObservations: (query) => {
        factQueries.push(query);
        let rows = FACTS.filter((f) => f.dataset === query.datasetCode);
        rows = rows.filter((f) => {
          const view = toObservation(f);
          const scope = query.geoScope;
          if (scope.kind === 'nonGeographic') return view.geography === null;
          if (scope.kind === 'explicitSource')
            return scope.pairs.some(
              (pairs) => JSON.stringify(pairs) === JSON.stringify(view.geography?.pairs)
            );
          const node = view.territory;
          return (
            node !== null &&
            view.geography?.qualified === false &&
            (scope.territoryIds === undefined || scope.territoryIds.includes(node.territoryId)) &&
            (scope.levels === undefined || scope.levels.includes(node.level))
          );
        });
        if (query.pinGroups.length > 0)
          rows = rows.filter((f) => query.pinGroups.some((g) => matchesGroup(f, g)));
        if (query.unitNomItemIds !== undefined)
          rows = rows.filter((f) => (query.unitNomItemIds ?? []).includes(f.unit));
        if (query.periodStart !== undefined)
          rows = rows.filter(
            (f) => (TIME_TO_PERIOD.get(f.time)?.periodEnd ?? '') >= (query.periodStart ?? '')
          );
        if (query.periodEnd !== undefined)
          rows = rows.filter(
            (f) => (TIME_TO_PERIOD.get(f.time)?.periodStart ?? '') <= (query.periodEnd ?? '')
          );
        const ranges = query.periodRanges ?? [];
        if (ranges.length > 0) {
          rows = rows.filter((f) => {
            const p = TIME_TO_PERIOD.get(f.time);
            return (
              p !== undefined &&
              ranges.some((r) => p.periodEnd >= r.start && p.periodStart <= r.end)
            );
          });
        }
        rows = [...rows].sort(sortNewest);
        const window = rows.slice(query.offset, query.offset + query.limit + 1);
        const hasNextPage = window.length > query.limit;
        const kept = window.slice(0, query.limit);
        return R({
          nodes: kept.map(toObservation),
          totalCount:
            hasNextPage || (kept.length === 0 && query.offset > 0)
              ? null
              : query.offset + kept.length,
          hasNextPage,
          hasPreviousPage: query.offset > 0,
        });
      },
      latestForSeries: (series, perSeries, period) => {
        seriesReads.push(series.map((s) => s.key));
        const out: InsSeriesRow[] = [];
        const inPeriod = (f: Fact): boolean => {
          const p = TIME_TO_PERIOD.get(f.time);
          if (p === undefined) return false;
          if (period?.periodStart !== undefined && p.periodEnd < period.periodStart) return false;
          if (period?.periodEnd !== undefined && p.periodStart > period.periodEnd) return false;
          const ranges = period?.periodRanges ?? [];
          return (
            ranges.length === 0 ||
            ranges.some((r) => p.periodEnd >= r.start && p.periodStart <= r.end)
          );
        };
        for (const s of series) {
          const rows = FACTS.filter(
            (f) =>
              f.dataset === s.datasetCode &&
              f.unit === s.unitNomItemId &&
              f.slots.every((v, i) => (s.slots[i] ?? null) === v) &&
              inPeriod(f)
          )
            .sort(sortNewest)
            .slice(0, perSeries);
          for (const f of rows) out.push({ seriesKey: s.key, observation: toObservation(f) });
        }
        return R(out);
      },
    };
  return repo;
};
