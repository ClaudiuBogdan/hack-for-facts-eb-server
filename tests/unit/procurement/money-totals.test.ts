/**
 * Totals v2 core: defaults, one exclusion per fact, the invariant
 * (included + exclusions = population, count and value), the D6 note, the
 * withheld-supplier disclosure, and an explanation built only from what was
 * applied and counted.
 */
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  baniToLei,
  composeTotals,
  moneyTotals,
  parseTotalsRequest,
  type MoneyTotalsPort,
  type FactAggregate,
  type MoneyLabel,
  type TotalsRequest,
} from '@/modules/procurement/core/money-totals.js';

const request = (over: Partial<Parameters<typeof parseTotalsRequest>[0]> = {}): TotalsRequest =>
  parseTotalsRequest({
    id: 'r1',
    filters: { procurementKinds: ['contract_award'] },
    ...over,
  })._unsafeUnwrap();

const fact = (over: Partial<FactAggregate> = {}): FactAggregate => ({
  valueKind: 'awarded',
  status: 'awarded',
  additive: true,
  dated: true,
  inRange: true,
  hasAmount: true,
  jointWin: false,
  vatBasis: 'unknown',
  currency: 'RON',
  unverifiedHead: false,
  listValue: false,
  withheldSupplier: false,
  count: 1n,
  sumBani: 100n,
  nativeSumMinor: 100n,
  ...over,
});

const LABELS: MoneyLabel[] = [
  ['procurement_kind', 'contract_award', 'Atribuiri de contracte', 'Contract awards'],
  ['status', 'awarded', 'Atribuit', 'Awarded'],
  ['status', 'cancelled', 'Anulat', 'Cancelled'],
  ['value_kind', 'awarded', 'Valoare atribuită', 'Awarded value'],
  ['exclusion', 'no_value', 'Fără valoare', 'No value'],
  ['exclusion', 'undated', 'Fără dată', 'Undated'],
  ['exclusion', 'not_additive', 'Nu se adună', 'Not additive'],
  [
    'exclusion',
    'withheld_d6',
    'Furnizor nepublic: nimic selectat',
    'Supplier not public: nothing matched',
  ],
  [
    'exclusion',
    'association_unattributed',
    'Contracte comune, valoare neatribuită',
    'Joint contracts, value not attributed',
  ],
  [
    'disclosure',
    'withheld_supplier',
    'înregistrări cu furnizori nenumiți',
    'records from suppliers not named',
  ],
].map(([labelSet, key, labelRo, labelEn]) => ({
  labelSet: labelSet ?? '',
  key: key ?? '',
  labelRo: labelRo ?? '',
  labelEn: labelEn ?? '',
  meaningRo: '',
  meaningEn: '',
}));

describe('parseTotalsRequest', () => {
  it('applies the owner defaults: awarded status, awarded value', () => {
    const r = request();
    expect(r.filters.statuses).toEqual(['awarded']);
    expect(r.valueKinds).toEqual(['awarded']);
    expect(r.currencySubtotals).toBe(false);
  });

  it('requires the procurement kinds: kinds are never mixed by default', () => {
    const r = parseTotalsRequest({ id: 'x', filters: {} });
    expect(r._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'procurementKinds' });
  });

  it.each([
    [{ statuses: ['paid'] }, 'statuses'],
    [{ from: '2025-13' }, 'from'],
    [{ from: '2025-02-01', to: '2025-01-01' }, 'from'],
    [{ supplierCode: 'RO123' }, 'supplierCode'],
    [{ q: 'ab' }, 'q'],
    [{ cpvPrefix: '4' }, 'cpvPrefix'],
  ])('refuses %j naming %s', (filters, field) => {
    const r = parseTotalsRequest({
      id: 'x',
      filters: { procurementKinds: ['direct_acquisition'], ...filters },
    });
    expect(r._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field });
  });
});

describe('composeTotals', () => {
  it('sums exactly in bani and renders lei', () => {
    expect(baniToLei(123456789012345678n)).toBe('1234567890123456.78');
    expect(baniToLei(-5n)).toBe('-0.05');
    const answer = composeTotals(
      request(),
      [fact({ count: 2n, sumBani: 150n }), fact({ count: 1n, sumBani: 1n })],
      LABELS,
      '17'
    );
    expect(answer.totals[0]).toMatchObject({
      sumLei: '1.51',
      recordCount: '3',
      withValueCount: '3',
    });
    expect(answer.factBuild).toBe('17');
  });

  it('gives every left-out fact exactly one reason, in a fixed order', () => {
    const r = request({
      filters: { procurementKinds: ['contract_award'], from: '2025-01-01', supplierCode: '123' },
    });
    const answer = composeTotals(
      r,
      [
        fact({ status: 'cancelled', additive: false, hasAmount: false }), // status first
        fact({ additive: false, hasAmount: false }), // then not additive
        fact({ hasAmount: false, sumBani: 0n }), // then no value
        fact({ dated: false, inRange: false }), // then undated (a range was asked)
        fact({ jointWin: true }), // then joint win under a supplier filter
        fact(),
      ],
      LABELS,
      '17'
    );
    expect(answer.exclusions.map((e) => e.key)).toEqual([
      'association_unattributed',
      'no_value',
      'not_additive',
      'status:cancelled',
      'undated',
    ]);
    expect(answer.exclusions.find((e) => e.key === 'no_value')?.valueLei).toBeNull();
    expect(answer.totals[0]?.recordCount).toBe('1');
  });

  it('accounts for published notices: a status exclusion by default, not additive when asked', () => {
    // Notices award nothing: their facts are reported, non-additive values.
    const notice = fact({ status: 'published', valueKind: 'reported', additive: false });
    const notices = { procurementKinds: ['advertising_notice'] };
    const byDefault = composeTotals(
      request({ filters: notices, valueKinds: ['reported'] }),
      [notice],
      LABELS,
      '17'
    );
    expect(byDefault.exclusions.map((e) => e.key)).toEqual(['status:published']);
    expect(byDefault.totals[0]?.recordCount).toBe('0');
    const asked = composeTotals(
      request({ filters: { ...notices, statuses: ['published'] }, valueKinds: ['reported'] }),
      [notice],
      LABELS,
      '17'
    );
    expect(asked.filtersApplied.statuses).toEqual(['published']);
    expect(asked.exclusions.map((e) => e.key)).toEqual(['not_additive']);
    expect(asked.totals[0]?.recordCount).toBe('0');
    expect(asked.explanation.textEn).toMatch(/^Selected: /u);
  });

  it('names the value kind of every left-out item when several kinds are asked', () => {
    const answer = composeTotals(
      request({ valueKinds: ['awarded', 'framework_ceiling'] }),
      [
        fact({ additive: false, count: 2n }),
        fact({ valueKind: 'framework_ceiling', additive: false, count: 3n }),
        fact({ valueKind: 'framework_ceiling', status: 'cancelled', count: 1n }),
      ],
      LABELS,
      '17'
    );
    // framework_ceiling has no label in the fixture: its key stands in.
    expect(answer.explanation.textEn).toContain(
      'Left out: Awarded value: Not additive (2, 1.00 lei); framework_ceiling: Not additive (3, 1.00 lei), Cancelled (1, 1.00 lei).'
    );
    expect(answer.explanation.textRo).toContain(
      'Excluse: Valoare atribuită: Nu se adună (2, 1.00 lei);'
    );
  });

  it('groups flagged and disclosed items by value kind too, in both languages', () => {
    const answer = composeTotals(
      request({ valueKinds: ['awarded', 'framework_ceiling'] }),
      [
        fact({ unverifiedHead: true, count: 2n }),
        fact({ valueKind: 'framework_ceiling', withheldSupplier: true, count: 3n }),
      ],
      LABELS,
      '17'
    );
    const en = answer.explanation.textEn;
    const ro = answer.explanation.textRo;
    expect(en).toMatch(/Included, flagged: Awarded value: [^;.]+\(2\)\./u);
    expect(ro).toMatch(/Incluse, marcate: Valoare atribuită: [^;.]+\(2\)\./u);
    expect(en).toContain(
      'Includes: framework_ceiling: records from suppliers not named (3, 1.00 lei).'
    );
    expect(ro).toContain(
      'Include: framework_ceiling: înregistrări cu furnizori nenumiți (3, 1.00 lei).'
    );
  });

  it('keeps one flat list when one value kind is asked', () => {
    const answer = composeTotals(request(), [fact({ additive: false })], LABELS, '17');
    expect(answer.explanation.textEn).toContain('Left out: Not additive (');
  });

  it('includes an undated fact when no range is asked', () => {
    const answer = composeTotals(request(), [fact({ dated: false })], LABELS, '17');
    expect(answer.totals[0]?.recordCount).toBe('1');
    expect(answer.exclusions).toEqual([]);
  });

  it('keeps the invariant: included + exclusions = population, count and value', () => {
    const rows: FactAggregate[] = [];
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647);
    for (let i = 0; i < 400; i += 1) {
      const hasAmount = next() % 7 !== 0;
      rows.push(
        fact({
          status:
            (['awarded', 'cancelled', 'under_review', 'identity_review'] as const)[next() % 4] ??
            'awarded',
          additive: next() % 5 !== 0,
          hasAmount,
          dated: next() % 6 !== 0,
          jointWin: next() % 9 === 0,
          count: BigInt(1 + (next() % 50)),
          // The shell sums only non-null amounts: a row without one carries 0.
          sumBani: hasAmount ? BigInt(next() % 1_000_000) : 0n,
        })
      );
    }
    const r = request({
      filters: { procurementKinds: ['contract_award'], from: '2020-01-01', supplierCode: '1' },
    });
    const answer = composeTotals(r, rows, LABELS, '17');
    const total = answer.totals[0];
    const included = BigInt(total?.recordCount ?? '0');
    const excluded = answer.exclusions.reduce((acc, e) => acc + BigInt(e.count), 0n);
    expect(included + excluded).toBe(BigInt(answer.population[0]?.count ?? '-1'));
    const sum = (lei: string | null | undefined) =>
      lei === null || lei === undefined ? 0n : BigInt(lei.replace('.', ''));
    const valued =
      sum(total?.sumLei) + answer.exclusions.reduce((acc, e) => acc + sum(e.valueLei), 0n);
    expect(valued).toBe(rows.reduce((acc, row) => acc + row.sumBani, 0n));
  });

  it('a withheld supplier code matches nothing and says so, with no count', () => {
    const r = request({ filters: { procurementKinds: ['direct_acquisition'], supplierCode: '1' } });
    const answer = composeTotals(r, [fact()], LABELS, '17', { supplierWithheld: true });
    expect(answer.totals[0]).toMatchObject({ recordCount: '0', sumLei: '0.00' });
    expect(answer.notes.map((n) => n.key)).toEqual(['withheld_d6']);
    expect(answer.exclusions).toEqual([]);
    expect(answer.explanation.textEn).toContain('Supplier not public: nothing matched');
  });

  it('discloses included records from withheld suppliers, without excluding them', () => {
    const answer = composeTotals(
      request(),
      [fact({ withheldSupplier: true, count: 3n, sumBani: 300n }), fact()],
      LABELS,
      '17'
    );
    expect(answer.totals[0]).toMatchObject({ recordCount: '4', sumLei: '4.00' });
    expect(answer.disclosures).toEqual([
      expect.objectContaining({ key: 'withheld_supplier', count: '3', valueLei: '3.00' }),
    ]);
  });

  it('reports VAT mix and, on request, per-currency subtotals in native units', () => {
    const r = request({ currencySubtotals: true });
    const answer = composeTotals(
      r,
      [
        fact({ vatBasis: 'included', currency: 'EUR', nativeSumMinor: 2050n }),
        fact({ vatBasis: 'unknown', currency: 'RON' }),
      ],
      LABELS,
      '17'
    );
    expect(answer.totals[0]?.vatMix).toEqual({ excluded: '0', included: '1', unknown: '1' });
    expect(answer.totals[0]?.currencies).toEqual([
      { currency: 'EUR', sum: '20.50', count: '1' },
      { currency: 'RON', sum: '1.00', count: '1' },
    ]);
  });

  it('composes the explanation only from the applied filters, labels and counts', () => {
    const answer = composeTotals(
      request(),
      [fact(), fact({ status: 'cancelled', sumBani: 500n })],
      LABELS,
      '17'
    );
    expect(answer.explanation.textEn).toBe(
      'Selected: Contract awards; status: Awarded; value kind: Awarded value. Dated contract awards are counted only from an award day of 2021-01-01. Values are summed as published (no VAT conversion), in lei. Left out: Cancelled (1, 5.00 lei).'
    );
    expect(answer.explanation.textRo).toContain('Excluse: Anulat (1, 5.00 lei).');
  });

  it('shows a missing label as its key, never a guessed text', () => {
    const answer = composeTotals(request(), [fact({ status: 'withdrawn' })], [], '17');
    expect(answer.exclusions[0]).toMatchObject({ key: 'status:withdrawn', labelEn: 'withdrawn' });
  });
});

describe('moneyTotals (batch)', () => {
  const port = (over: Partial<MoneyTotalsPort> = {}) => {
    const reads: {
      supplierRef: string | null;
      kinds: readonly string[];
      caFloor: string;
      build: string;
    }[] = [];
    const floorBuilds: string[] = [];
    const p: MoneyTotalsPort = {
      activeBuild: () => Promise.resolve(ok('17')),
      caFloor: (build) => {
        floorBuilds.push(build);
        return Promise.resolve(ok(null));
      },
      labels: () => Promise.resolve(ok(LABELS)),
      supplierRef: (_build, code) => Promise.resolve(ok(code === '123' ? 'ref-123' : null)),
      aggregate: (build, _filters, supplierRef, kinds, caFloor) => {
        reads.push({ supplierRef, kinds, caFloor, build });
        return Promise.resolve(ok([fact()]));
      },
      ...over,
    };
    return { p, reads, floorBuilds };
  };
  const ca = { procurementKinds: ['contract_award'] };

  it('reads once per distinct non-status filter set, for the union of value kinds', async () => {
    const { p, reads } = port();
    const result = await moneyTotals(p, [
      { id: 'a', filters: ca },
      {
        id: 'b',
        filters: { ...ca, statuses: ['awarded', 'cancelled'] },
        valueKinds: ['framework_ceiling'],
      },
      { id: 'c', filters: { ...ca, from: '2025-01-01' } },
    ]);
    const answers = result._unsafeUnwrap();
    expect(answers.map((a) => [a.id, a.factBuild])).toEqual([
      ['a', '17'],
      ['b', '17'],
      ['c', '17'],
    ]);
    expect(reads).toHaveLength(2);
    expect(reads[0]?.kinds).toEqual(['awarded', 'framework_ceiling']);
  });

  it('a supplier code that is not public reads nothing and answers the D6 note', async () => {
    const { p, reads } = port();
    const [answer] = (
      await moneyTotals(p, [{ id: 'a', filters: { ...ca, supplierCode: '999' } }])
    )._unsafeUnwrap();
    expect(reads).toEqual([]);
    expect(answer?.notes.map((n) => n.key)).toEqual(['withheld_d6']);
    expect(answer?.totals[0]?.recordCount).toBe('0');
  });

  it('passes a public supplier ref to the read', async () => {
    const { p, reads } = port();
    await moneyTotals(p, [{ id: 'a', filters: { ...ca, supplierCode: '123' } }]);
    expect(reads[0]?.supplierRef).toBe('ref-123');
  });

  it('reads contract awards under the build’s own floor, 2021-01-01 while it records none', async () => {
    const { p, reads, floorBuilds } = port();
    const [answer] = (await moneyTotals(p, [{ id: 'a', filters: ca }]))._unsafeUnwrap();
    expect(floorBuilds).toEqual(['17']);
    expect(reads.map((r) => [r.build, r.caFloor])).toEqual([['17', '2021-01-01']]);
    expect(answer?.caAwardDayFrom).toBe('2021-01-01');
    expect(answer?.explanation.textEn).toContain(
      'Dated contract awards are counted only from an award day of 2021-01-01.'
    );
    expect(answer?.explanation.textRo).toContain(
      'Contractele atribuite cu dată sunt numărate doar de la data atribuirii 2021-01-01.'
    );

    const recorded = port({ caFloor: () => Promise.resolve(ok('2018-01-01')) });
    const [later] = (await moneyTotals(recorded.p, [{ id: 'a', filters: ca }]))._unsafeUnwrap();
    expect(recorded.reads[0]?.caFloor).toBe('2018-01-01');
    expect(later?.caAwardDayFrom).toBe('2018-01-01');
    expect(later?.explanation.textEn).toContain('award day of 2018-01-01.');
    expect(later?.explanation.textEn).not.toContain('2021');
  });

  it('serves 2021-01-01 for a recorded day ClickHouse cannot hold or that is not a day', async () => {
    for (const day of ['1969-12-31', '2149-06-07', '2018-02-30', '2018-1-1', '']) {
      const { p, reads } = port({ caFloor: () => Promise.resolve(ok(day)) });
      const [answer] = (await moneyTotals(p, [{ id: 'a', filters: ca }]))._unsafeUnwrap();
      expect(reads[0]?.caFloor, day).toBe('2021-01-01');
      expect(answer?.caAwardDayFrom, day).toBe('2021-01-01');
    }
  });

  it('reads no floor for a batch without contract awards, and serves the fallback when it fails', async () => {
    const { p, floorBuilds } = port();
    const [da] = (
      await moneyTotals(p, [{ id: 'a', filters: { procurementKinds: ['direct_acquisition'] } }])
    )._unsafeUnwrap();
    expect(floorBuilds).toEqual([]);
    expect(da?.caAwardDayFrom).toBeNull();
    expect(da?.explanation.textEn).not.toContain('contract awards are counted');
    // A failed floor read (a timeout, say) never refuses the batch: the fallback, named.
    const failing = port({
      caFloor: () => Promise.resolve(err({ type: 'DatabaseError', message: 'x' } as never)),
    });
    const [answer] = (await moneyTotals(failing.p, [{ id: 'a', filters: ca }]))._unsafeUnwrap();
    expect(failing.reads.map((r) => r.caFloor)).toEqual(['2021-01-01']);
    expect(answer?.caAwardDayFrom).toBe('2021-01-01');
  });

  it('fails closed when no money build is published', async () => {
    const { p } = port({ activeBuild: () => Promise.resolve(ok(null)) });
    const result = await moneyTotals(p, [{ id: 'a', filters: ca }]);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
  });

  it('refuses an empty batch, more than 8 requests, and names a bad request field', async () => {
    const { p } = port();
    expect((await moneyTotals(p, []))._unsafeUnwrapErr()).toMatchObject({ field: 'requests' });
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: String(i), filters: ca }));
    expect((await moneyTotals(p, nine))._unsafeUnwrapErr()).toMatchObject({ field: 'requests' });
    expect(
      (await moneyTotals(p, [{ id: 'a', filters: { procurementKinds: ['x'] } }]))._unsafeUnwrapErr()
    ).toMatchObject({ field: 'procurementKinds' });
  });

  it('shares one read between equal filter sets listed in another order', async () => {
    const { p, reads } = port();
    await moneyTotals(p, [
      { id: 'a', filters: { procurementKinds: ['contract_award', 'direct_acquisition'] } },
      { id: 'b', filters: { procurementKinds: ['direct_acquisition', 'contract_award'] } },
    ]);
    expect(reads).toHaveLength(1);
  });

  it.each([
    ['from', '2025-02-30'],
    ['to', '1969-12-31'],
    ['to', '2149-06-07'],
  ])('refuses %s=%s: not a day ClickHouse can hold exactly', async (field, value) => {
    const { p } = port();
    const result = await moneyTotals(p, [{ id: 'a', filters: { ...ca, [field]: value } }]);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field });
  });

  describe('under site-wide D6', () => {
    const disclosure = (codes: string[], asOf = '2026-11-20T00:00:00.000000Z', fresh = asOf) => ({
      enforced: true,
      publicSupplierCodes: (options?: { fresh?: boolean }) =>
        Promise.resolve(
          ok(Object.assign(new Set(codes), { asOf: options?.fresh === true ? fresh : asOf }))
        ),
      privacyAsOf: () => Promise.resolve(ok(asOf)),
    });

    it('a code the current publication withholds matches nothing, even if the build lists it', async () => {
      const { p, reads } = port();
      const [answer] = (
        await moneyTotals(p, [{ id: 'a', filters: { ...ca, supplierCode: '123' } }], disclosure([]))
      )._unsafeUnwrap();
      expect(reads).toEqual([]);
      expect(answer?.notes.map((n) => n.key)).toEqual(['withheld_d6']);
      // The withheld code is never echoed.
      expect(answer?.filtersApplied.supplierCode).toBeNull();
      expect(JSON.stringify(answer)).not.toContain('123');
      expect(answer?.disclosureKey).toBe('2026-11-20T00:00:00.000000Z');
    });

    it('a public code reads, keyed by the publication', async () => {
      const { p, reads } = port();
      const [answer] = (
        await moneyTotals(
          p,
          [{ id: 'a', filters: { ...ca, supplierCode: '123' } }],
          disclosure(['123'])
        )
      )._unsafeUnwrap();
      expect(reads[0]?.supplierRef).toBe('ref-123');
      expect(answer?.disclosureKey).toBe('2026-11-20T00:00:00.000000Z');
    });

    it('asks for a repeat when the list is republished during a supplier read', async () => {
      const { p } = port();
      const result = await moneyTotals(
        p,
        [{ id: 'a', filters: { ...ca, supplierCode: '123' } }],
        disclosure(['123'], 'v1', 'v2')
      );
      expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
    });
  });

  it('lists the summable value kinds for the asked procurement kinds, and label meanings', async () => {
    const { p } = port();
    const [answer] = (
      await moneyTotals(p, [
        { id: 'a', filters: { procurementKinds: ['direct_acquisition', 'advertising_notice'] } },
      ])
    )._unsafeUnwrap();
    expect(answer?.allowed.valueKinds).toEqual(['awarded']);
    expect(answer?.disclosureKey).toBe('off');
    expect(answer?.included.statuses[0]).toHaveProperty('meaningEn');
  });
});
