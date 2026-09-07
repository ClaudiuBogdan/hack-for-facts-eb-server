/** Derive replay requests from saved membership, never from current source availability. */
import { err, ok, type Result } from 'neverthrow';

import {
  createInvalidInputError,
  type GroupedSeriesError,
} from '../../grouped-series/core/errors.js';

import type { FinancialMapGroupRequest } from '../../grouped-series/core/types.js';

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = () =>
  err(createInvalidInputError('Stored financial map groups have invalid or ambiguous membership'));

function indexRecords(values: unknown[]): Map<unknown, RecordValue[]> {
  const index = new Map<unknown, RecordValue[]>();
  for (const value of values) {
    if (!isRecord(value)) continue;
    const entries = index.get(value['id']) ?? [];
    entries.push(value);
    index.set(value['id'], entries);
  }
  return index;
}

/** Modern properties win even when empty; aliases only support pre-migration snapshots. */
export function deriveSnapshotFinancialGroups(
  state: RecordValue
): Result<FinancialMapGroupRequest[], GroupedSeriesError> {
  if (!Array.isArray(state['series'])) return ok([]);
  const series = state['series'].filter(isRecord);
  const requests = new Map<string, FinancialMapGroupRequest>();
  const rawWorkspaces = Object.hasOwn(state, 'groupWorkspaces')
    ? state['groupWorkspaces']
    : state['groupings'];

  const sourcesById = indexRecords(series);
  const workspacesById = indexRecords(Array.isArray(rawWorkspaces) ? rawWorkspaces : []);
  const membersByWorkspace = new Map<string, { id: string; members: string[] }[]>();
  const processed = new Set<string>();

  for (const item of series) {
    if (item['type'] !== 'map-grouped-value-series' || (item['aggregation'] ?? 'sum') !== 'sum')
      continue;
    const sources = sourcesById.get(item['sourceSeriesId']) ?? [];
    const source = sources[0];
    if (
      source === undefined ||
      (source['type'] !== 'line-items-aggregated-yearly' &&
        source['type'] !== 'commitments-analytics')
    )
      continue;
    const filter = source['filter'];
    if (
      !isRecord(filter) ||
      (filter['normalization'] !== 'per_capita' && filter['normalization'] !== 'per_capita_euro')
    )
      continue;
    const sourceId = item['sourceSeriesId'];
    const workspaceId = Object.hasOwn(item, 'groupWorkspaceId')
      ? item['groupWorkspaceId']
      : item['groupingId'];
    if (workspaceId === undefined || workspaceId === '') continue;
    if (sources.length !== 1 || typeof sourceId !== 'string' || typeof workspaceId !== 'string')
      return invalid();
    if (rawWorkspaces !== undefined && !Array.isArray(rawWorkspaces)) return invalid();
    const workspaces = workspacesById.get(workspaceId) ?? [];
    if (workspaces.length === 0) continue;
    if (workspaces.length !== 1 || !isRecord(workspaces[0])) return invalid();
    const pairKey = JSON.stringify([workspaceId, sourceId]);
    if (processed.has(pairKey)) continue;
    processed.add(pairKey);
    let normalized = membersByWorkspace.get(workspaceId);
    if (normalized === undefined) {
      normalized = [];
      const groups = workspaces[0]['groups'] ?? [];
      if (!Array.isArray(groups)) return invalid();
      const ids = new Set<string>();
      const memberOwners = new Set<string>();
      for (const group of groups) {
        if (!isRecord(group) || typeof group['id'] !== 'string' || ids.has(group['id']))
          return invalid();
        ids.add(group['id']);
        const rawMembers = group['memberSirutaCodes'] ?? [];
        if (
          !Array.isArray(rawMembers) ||
          !rawMembers.every((value): value is string => typeof value === 'string')
        )
          return invalid();
        const members = [
          ...new Set(rawMembers.map((value) => value.trim()).filter(Boolean)),
        ].sort();
        if (members.some((value) => memberOwners.has(value))) return invalid();
        members.forEach((value) => memberOwners.add(value));
        if (members.length === 0) continue;
        normalized.push({ id: group['id'], members });
      }
      membersByWorkspace.set(workspaceId, normalized);
    }
    for (const group of normalized) {
      const request = {
        groupWorkspaceId: workspaceId,
        groupId: group.id,
        sourceSeriesId: sourceId,
        memberTerritoryCodes: group.members,
      };
      requests.set(JSON.stringify([workspaceId, group.id, sourceId]), request);
      if (requests.size > 256) return invalid();
    }
  }

  return ok(
    [...requests.values()].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    )
  );
}
