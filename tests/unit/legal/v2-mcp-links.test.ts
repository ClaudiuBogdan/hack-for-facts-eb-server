/**
 * MCP `get_legal_act_links` on the legal_v2 source: the citing acts carry
 * their default document (`f<form_id>`), filled from ONE batched default-form
 * read over every citing act, never one query per row.
 */

import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { mergeBridgedAct } from '@/modules/legal/core/v2/bridge.js';
import { makeLegalMcpTools } from '@/modules/legal/shell/mcp/tools.js';

import type { LegalActsRepo, LegalGraphRepo } from '@/modules/legal/core/ports.js';
import type { V2DefaultForm } from '@/modules/legal/core/v2/forms.js';

const act = (actId: string) =>
  mergeBridgedAct(
    {
      actId,
      actNaturalKey: `k${actId}`,
      actType: 'lege',
      actNumber: actId,
      actYear: 2020,
      issuerSlug: 'parlamentul',
      displayCitation: `Legea nr. ${actId}/2020`,
      ended: false,
    },
    { status: 'in-vigoare', statusEvidence: {}, entryIntoForce: null, inDegree: 1 }
  );

const def = (actId: string, formId: string | null): V2DefaultForm => ({
  actId,
  policy: 'latest_any_kind',
  posture: formId === null ? 'no_known_form' : 'current',
  defaultFormId: formId,
  chosenFormId: formId,
  latestAvailableFormId: formId,
  positionDate: null,
  formsAtPosition: formId === null ? 0 : 1,
  orderReviewed: formId === null ? null : true,
  tieBasis: null,
  newerNotAvailable: 0,
  laterOtherKind: 0,
  formsWithoutPosition: 0,
});

describe('MCP incoming links on legal_v2', () => {
  it('fills each citing act default document from one batched read', async () => {
    const calls: (readonly string[])[] = [];
    const acts = {
      findActById: () => Promise.resolve(ok(act('7'))),
      findActsByIds: (ids: readonly string[]) => Promise.resolve(ok(ids.map(act))),
      defaultFormsForActs: (ids: readonly string[]) => {
        calls.push(ids);
        return Promise.resolve(
          ok(
            new Map([
              ['10', def('10', '110')],
              ['11', def('11', null)],
              // Latest form 131 has no text; 130 is readable: the fallback travels with the act.
              [
                '13',
                {
                  ...def('13', null),
                  posture: 'latest_not_available',
                  chosenFormId: '131',
                  latestAvailableFormId: '130',
                },
              ],
            ])
          )
        );
      },
    } as unknown as LegalActsRepo;
    const edge = (doc: string) => ({
      sourceDocumentId: doc,
      refIndex: 1,
      relation: 'modifica',
      targetRaw: 'x',
      targetClass: 'domestic',
      targetActId: '7',
      targetExternalActId: null,
      targetFragment: null,
      resolution: 'unique',
      confidence: null,
    });
    const graph = {
      incomingRefs: () =>
        Promise.resolve(
          ok({
            items: [
              { edge: edge('D10b'), sourceAct: null, sourceActId: '10' },
              { edge: edge('D11'), sourceAct: null, sourceActId: '11' },
              { edge: edge('D12'), sourceAct: null, sourceActId: '10' },
              { edge: edge('D13'), sourceAct: null, sourceActId: '13' },
            ],
            next: null,
          })
        ),
    } as unknown as LegalGraphRepo;
    const tool = makeLegalMcpTools({
      acts,
      graph,
      outline: {} as never,
      searchDeps: {} as never,
      resolveDeps: {} as never,
      clientBaseUrl: 'https://t',
      v2: true,
    }).find((t) => t.name === 'get_legal_act_links');
    const out = (await tool?.handler({ actId: '7', direction: 'in' })) as unknown as {
      items: {
        sourceAct: {
          actId: string;
          canonicalDocumentId: string | null;
          defaultBasis: string | null;
          latestDocumentId: string | null;
          latestAvailableDocumentId: string | null;
        } | null;
      }[];
    };
    expect(
      out.items.map((i) => [
        i.sourceAct?.actId,
        i.sourceAct?.canonicalDocumentId,
        i.sourceAct?.defaultBasis,
        i.sourceAct?.latestDocumentId,
        i.sourceAct?.latestAvailableDocumentId,
      ])
    ).toEqual([
      ['10', 'f110', 'current', 'f110', 'f110'],
      ['11', null, 'no_known_form', null, null],
      ['10', 'f110', 'current', 'f110', 'f110'],
      ['13', null, 'latest_not_available', 'f131', 'f130'],
    ]);
    expect(calls).toEqual([['10', '11', '10', '13']]);
  });
});
