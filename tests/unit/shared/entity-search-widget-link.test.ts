/**
 * Entity-search widget — where a row opens and the registry status it shows
 * (`widgets/src/entity-search/hit-link.ts`, the widget's pure part).
 */

import { describe, expect, it } from 'vitest';

import { hitHref, ngoStatusChip } from '../../../widgets/src/entity-search/hit-link.js';
import { renderRow } from '../../../widgets/src/entity-search/row.js';

describe('entity-search widget — row link', () => {
  it('opens the server-built client page first, on its own base', () => {
    expect(hitHref({ link: 'https://dev-chronos.transparenta.eu/ngos/registry/4321-A-2024' })).toBe(
      'https://dev-chronos.transparenta.eu/ngos/registry/4321-A-2024'
    );
    expect(
      hitHref({ link: 'https://dev-chronos.transparenta.eu/ngos/3151288', url: '/ong/3151288' })
    ).toBe('https://dev-chronos.transparenta.eu/ngos/3151288');
  });

  it('falls back to the index url, and drops anything that is not http(s) or site-relative', () => {
    expect(hitHref({ url: 'https://mfinante.gov.ro/x' })).toBe('https://mfinante.gov.ro/x');
    expect(hitHref({ url: '/companies/42' })).toBe('https://transparenta.eu/companies/42');
    expect(hitHref({ link: 'javascript:alert(1)', url: '//evil.example/x' })).toBeUndefined();
    expect(hitHref({})).toBeUndefined();
  });
});

describe('entity-search widget — NGO registry status', () => {
  it('shows the registry’s status where it is not registered, in its own words', () => {
    expect(ngoStatusChip('Radiat')).toBe('Radiat');
    expect(ngoStatusChip('Dizolvata')).toBe('Dizolvată');
    expect(ngoStatusChip('In Lichidare')).toBe('În lichidare');
  });

  it('shows nothing for a status it does not know, as the client: never closed by guess', () => {
    expect(ngoStatusChip('Suspendat')).toBeUndefined();
    expect(ngoStatusChip('INREGISTRAT')).toBeUndefined();
  });

  it('takes no inherited object key for a status', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(ngoStatusChip(key)).toBeUndefined();
    }
  });

  it('shows nothing for a registered NGO or a hit without a registry status', () => {
    expect(ngoStatusChip('Inregistrat')).toBeUndefined();
    expect(ngoStatusChip(undefined)).toBeUndefined();
    expect(ngoStatusChip(' ')).toBeUndefined();
  });
});

describe('entity-search widget — row', () => {
  const ngo = {
    docType: 'ngo',
    title: 'ASOCIATIA <b>X</b>',
    countyName: 'Cluj',
    cuis: [] as string[],
    ngoRegistryNumber: '4321/A/2024',
    ngoRegistryStatus: 'Radiat',
    attrs: { status: 'active' },
  };

  it('shows a CUI-less NGO by its registry number and its registry status, escaped', () => {
    const html = renderRow({ ...ngo, ngoRegistryNumber: '1/A/<i>' }, 0);
    expect(html).toContain('Nr. registru 1/A/&lt;i&gt;');
    expect(html).toContain('<span class="chip-inactive">Radiat</span>');
    expect(html).toContain('ASOCIATIA &lt;b&gt;X&lt;/b&gt;');
    expect(html).not.toContain('<b>X</b>');
  });

  it('never shows the generic „Inactiv" for an NGO the registry holds as registered', () => {
    const html = renderRow(
      {
        ...ngo,
        cuis: ['3151288'],
        ngoRegistryStatus: 'Inregistrat',
        attrs: { status: 'inactive' },
      },
      0
    );
    expect(html).not.toContain('chip-inactive');
    expect(html).toContain('CUI 3151288');
    expect(html).not.toContain('Nr. registru');
  });

  it('shows no chip for a registry row without a status, whatever its generic attributes say', () => {
    // An NGO the index gives no registry status.
    const plain = renderRow(
      { docType: 'ngo', title: 'ASOCIATIA Y', cuis: ['3151288'], attrs: { status: 'inactive' } },
      0
    );
    expect(plain).not.toContain('chip-inactive');
    // A registry organisation the index files under another type, known by its registry number.
    const filed = renderRow(
      {
        docType: 'company',
        title: 'ASOCIATIA Z',
        cuis: ['42'],
        ngoRegistryNumber: '9/A/2001',
        attrs: { status: 'inactive' },
      },
      0
    );
    expect(filed).not.toContain('chip-inactive');
  });

  it('shows no chip for a registry status that only an object key would match', () => {
    for (const key of ['constructor', 'toString', '__proto__']) {
      const html = renderRow({ ...ngo, ngoRegistryStatus: key, attrs: { status: 'inactive' } }, 0);
      expect(html).not.toContain('chip-inactive');
    }
  });

  it('keeps the generic chip for a hit outside the registry', () => {
    const html = renderRow(
      { docType: 'company', title: 'ACME', cuis: ['42'], attrs: { status: 'inactive' } },
      0
    );
    expect(html).toContain('<span class="chip-inactive">Inactiv</span>');
  });
});
