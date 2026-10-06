import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  MAX_PAGE_SIZE,
  type ApiError,
  type IdentityRepo,
  type Organization,
} from '@/modules/shared/index.js';

import { parseVirtualFilters } from './filters.js';

import type { PublicEnterpriseRepository } from './ports.js';
import type {
  PublicEnterpriseIndicatorPage,
  PublicEnterpriseIndicatorRequest,
  PublicEnterpriseListRequest,
  PublicEnterprisePage,
  PublicEnterpriseProfile,
  PublicEnterpriseSource,
} from './types.js';

/** Digits only, 2–10, as the canonical anchor table admits. */
export const PUBLIC_ENTERPRISE_CUI = /^[0-9]{2,10}$/u;
/** Bounded name resolution for the MCP discovery tool (no scan of the registry). */
export const PUBLIC_ENTERPRISE_NAME_MATCH_LIMIT = 50;

export interface PublicEnterpriseDeps {
  readonly repo: PublicEnterpriseRepository;
  readonly identityRepo: Pick<IdentityRepo, 'findManyByCui' | 'searchByName'>;
}

const invalidCui = () => invalidInput('Expected a canonical CUI (2-10 digits).', 'cui');

/**
 * Attach kernel identities in ONE batch. A withheld or absent identity is
 * `organization: null`; the public record itself is always kept.
 */
const withOrganizations = async <T extends { readonly cui: string }>(
  deps: PublicEnterpriseDeps,
  rows: readonly T[]
): Promise<Result<(T & { readonly organization: Organization | null })[], ApiError>> => {
  if (rows.length === 0) return ok([]);
  const identities = await deps.identityRepo.findManyByCui(rows.map((row) => row.cui));
  if (identities.isErr()) return err(identities.error);
  return ok(rows.map((row) => ({ ...row, organization: identities.value.get(row.cui) ?? null })));
};

export const listPublicEnterpriseSources = (
  deps: PublicEnterpriseDeps
): Promise<Result<readonly PublicEnterpriseSource[], ApiError>> => deps.repo.sources();

export const getPublicEnterpriseProfile = async (
  deps: PublicEnterpriseDeps,
  cui: string
): Promise<Result<PublicEnterpriseProfile | null, ApiError>> => {
  if (!PUBLIC_ENTERPRISE_CUI.test(cui)) return err(invalidCui());
  const record = await deps.repo.profile(cui);
  if (record.isErr()) return err(record.error);
  if (record.value === null) return ok(null);
  const named = await withOrganizations(deps, [record.value]);
  if (named.isErr()) return err(named.error);
  return ok(named.value[0] ?? null);
};

const checkPage = (page: number, pageSize: number): ApiError | null => {
  if (!Number.isInteger(page) || page < 1)
    return invalidInput('page must be an integer >= 1', 'page');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
    return invalidInput(
      `pageSize must be an integer from 1 to ${String(MAX_PAGE_SIZE)}`,
      'pageSize'
    );
  return null;
};

export const listPublicEnterprises = async (
  deps: PublicEnterpriseDeps,
  request: PublicEnterpriseListRequest
): Promise<Result<PublicEnterprisePage, ApiError>> => {
  const bad = checkPage(request.page, request.pageSize);
  if (bad !== null) return err(bad);
  const virtual = parseVirtualFilters(request.filter);
  if (virtual.isErr()) return err(virtual.error);
  const page = await deps.repo.list(request);
  if (page.isErr()) return err(page.error);
  const items = await withOrganizations(deps, page.value.items);
  if (items.isErr()) return err(items.error);
  return ok({ ...page.value, items: items.value });
};

export const listPublicEnterpriseIndicators = (
  deps: PublicEnterpriseDeps,
  request: PublicEnterpriseIndicatorRequest
): Promise<Result<PublicEnterpriseIndicatorPage, ApiError>> => {
  if (!PUBLIC_ENTERPRISE_CUI.test(request.cui)) return Promise.resolve(err(invalidCui()));
  if (!Number.isInteger(request.first) || request.first < 1 || request.first > MAX_PAGE_SIZE)
    return Promise.resolve(
      err(invalidInput(`first must be an integer from 1 to ${String(MAX_PAGE_SIZE)}`, 'first'))
    );
  return deps.repo.indicators(request);
};

/**
 * MCP discovery: a CUI is looked up directly; a name goes through the kernel's
 * bounded name resolution and the matches are intersected with the public
 * anchors by the ordinary list filter (no registry scan, no new projection).
 */
export const searchPublicEnterprises = async (
  deps: PublicEnterpriseDeps,
  request: PublicEnterpriseListRequest & { readonly q?: string }
): Promise<Result<PublicEnterprisePage, ApiError>> => {
  const q = request.q?.trim();
  if (q === undefined || q === '') return listPublicEnterprises(deps, request);
  let cuis: string[];
  if (PUBLIC_ENTERPRISE_CUI.test(q)) {
    cuis = [q];
  } else {
    if (q.length < 2 || q.length > 100)
      return err(invalidInput('q must be 2 to 100 characters', 'q'));
    const matches = await deps.identityRepo.searchByName(q, PUBLIC_ENTERPRISE_NAME_MATCH_LIMIT);
    if (matches.isErr()) return err(matches.error);
    cuis = [
      ...new Set(
        matches.value.flatMap((match) =>
          match.cui !== null && PUBLIC_ENTERPRISE_CUI.test(match.cui) ? [match.cui] : []
        )
      ),
    ];
  }
  const requested = request.filter['cuis']?.['in'];
  const narrowed = Array.isArray(requested)
    ? cuis.filter((cui) => (requested as readonly unknown[]).includes(cui))
    : cuis;
  return listPublicEnterprises(deps, {
    ...request,
    filter: { ...request.filter, cuis: { in: narrowed } },
  });
};
