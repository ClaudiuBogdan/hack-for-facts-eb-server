import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  companyLitigationLink,
  judicialCaseLink,
  judicialCaseloadLink,
} from '../../../src/modules/judicial/shell/mcp/client-links.js';
import { makeJudicialMcpTools } from '../../../src/modules/judicial/shell/mcp/tools.js';

import type { JudicialRepos } from '../../../src/modules/judicial/core/usecases.js';

// JC26-API-04: the judicial MCP tools linked to `/judicial/...`, which the
// client does not serve (HTTP 404). These are the client's own routes, and a
// result the client cannot show exactly gets no link.
const BASE = 'https://transparenta.eu';

describe('judicial MCP client links', () => {
  it('opens a case at its court and number, the number keeping its slashes', () => {
    expect(judicialCaseLink(BASE, 'TribunalulBUCURESTI', '33517/3/2021/a85')).toBe(
      'https://transparenta.eu/justice/cases/TribunalulBUCURESTI/33517/3/2021/a85'
    );
    expect(judicialCaseLink(BASE, 'JudecatoriaSECTORUL1BUCURESTI', '1234/3/2024*')).toBe(
      'https://transparenta.eu/justice/cases/JudecatoriaSECTORUL1BUCURESTI/1234/3/2024*'
    );
    // Every other character is escaped, segment by segment (the client's casePath).
    expect(judicialCaseLink(BASE, 'TribunalulCLUJ', '17020,/245/2008')).toBe(
      'https://transparenta.eu/justice/cases/TribunalulCLUJ/17020%2C/245/2008'
    );
  });

  it('gives a case no link when the client route would reject its court or number', () => {
    expect(judicialCaseLink(BASE, '..', '1/2/2020')).toBeNull();
    expect(judicialCaseLink(BASE, 'TribunalulCLUJ', '1/../x')).toBeNull();
    expect(judicialCaseLink(BASE, 'TribunalulCLUJ', 'abc/2020')).toBeNull();
  });

  it('opens a one-year caseload with cases at that year of the court page, or of the analysis page', () => {
    expect(
      judicialCaseloadLink(
        BASE,
        { institutionCode: ['TribunalulSALAJ'], yearFrom: 2007, yearTo: 2007 },
        12
      )
    ).toBe('https://transparenta.eu/justice/courts/TribunalulSALAJ?an=2007');
    expect(judicialCaseloadLink(BASE, { yearFrom: 2025, yearTo: 2025 }, 1677596)).toBe(
      'https://transparenta.eu/justice/analytics?an=2025'
    );
  });

  it('gives no link to a caseload the client has no page for, never a wider or another year', () => {
    // Several courts with a category: the analysis page would show all courts and matters.
    expect(
      judicialCaseloadLink(
        BASE,
        {
          institutionCode: ['TribunalulSALAJ', 'TribunalulCLUJ'],
          category: ['Penal'],
          yearFrom: 2025,
          yearTo: 2025,
        },
        3
      )
    ).toBeNull();
    expect(
      judicialCaseloadLink(
        BASE,
        { institutionCode: ['TribunalulSALAJ', 'TribunalulCLUJ'], yearFrom: 2025, yearTo: 2025 },
        3
      )
    ).toBeNull();
    expect(
      judicialCaseloadLink(BASE, { courtLevel: ['tribunal'], yearFrom: 2025, yearTo: 2025 }, 3)
    ).toBeNull();
    expect(
      judicialCaseloadLink(BASE, { category: ['Penal'], yearFrom: 2025, yearTo: 2025 }, 3)
    ).toBeNull();
    // Every year, a range or an open bound: the client pages describe one year.
    expect(judicialCaseloadLink(BASE, { institutionCode: ['TribunalulSALAJ'] }, 3)).toBeNull();
    expect(judicialCaseloadLink(BASE, { yearFrom: 2020, yearTo: 2025 }, 3)).toBeNull();
    expect(judicialCaseloadLink(BASE, { yearFrom: 2020 }, 3)).toBeNull();
    // A year without cases (2030) is not a year the client holds: it would show its default year instead.
    expect(
      judicialCaseloadLink(
        BASE,
        { institutionCode: ['TribunalulSALAJ'], yearFrom: 2030, yearTo: 2030 },
        0
      )
    ).toBeNull();
    // A court code the client does not accept never shapes the path (`..` would leave the courts route).
    expect(
      judicialCaseloadLink(BASE, { institutionCode: ['..'], yearFrom: 2025, yearTo: 2025 }, 3)
    ).toBeNull();
  });

  it('opens a company litigation summary at the litigation band of the company profile', () => {
    expect(companyLitigationLink(BASE, '14399840')).toBe(
      'https://transparenta.eu/companies/14399840#litigii'
    );
    expect(companyLitigationLink(BASE, 'RO 14399840')).toBeNull();
    expect(companyLitigationLink(BASE, '0000')).toBeNull();
  });
});

describe('judicial MCP tool links', () => {
  const summary = {
    cui: '14399840',
    companyName: null,
    caseCount: 0,
    courtLevels: [],
    years: [],
    coverage: 0,
    caveats: [],
  };
  const repos = {
    companyLinks: { summaryForCui: () => Promise.resolve(ok(summary)) },
    cases: {
      aggregate: () => Promise.resolve(ok({ groups: [], denominator: 12, coverage: 1 })),
    },
  } as unknown as JudicialRepos;
  const tools = makeJudicialMcpTools({ repos, clientBaseUrl: BASE });
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };

  it('gives a filtered company summary no link: the profile band shows the unfiltered one', async () => {
    const out = await tool('get_company_litigation').handler({
      cui: '14399840',
      category: ['Penal'],
    });
    expect(out).not.toHaveProperty('link');
    const byYear = await tool('get_company_litigation').handler({
      cui: '14399840',
      yearFrom: 2020,
      yearTo: 2020,
    });
    expect(byYear).not.toHaveProperty('link');
  });

  it('links a company by the normalized CUI the result carries, not the argument as typed', async () => {
    const out = (await tool('get_company_litigation').handler({ cui: 'RO 14399840' })) as {
      readonly link?: string;
    };
    expect(out.link).toBe('https://transparenta.eu/companies/14399840#litigii');
  });

  it('omits the caseload link when the selection has no client page', async () => {
    const narrowed = (await tool('get_court_caseload').handler({
      groupBy: 'court',
      institutionCode: ['TribunalulSALAJ', 'TribunalulCLUJ'],
      category: ['Penal'],
      yearFrom: 2025,
      yearTo: 2025,
    })) as { readonly ok: boolean; readonly link?: string };
    expect(narrowed.ok).toBe(true);
    expect(narrowed).not.toHaveProperty('link');
    const court = (await tool('get_court_caseload').handler({
      groupBy: 'court',
      institutionCode: ['TribunalulSALAJ'],
      yearFrom: 2007,
      yearTo: 2007,
    })) as { readonly link?: string };
    expect(court.link).toBe('https://transparenta.eu/justice/courts/TribunalulSALAJ?an=2007');
  });
});
