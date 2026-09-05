import { err, ok, type Result } from 'neverthrow';

import { parseMemberCode } from './identity.js';
import { MAX_SLOTS, type InsDimensionView, type InsSourcePin, type SlotPins } from './types.js';

import type { InsRepo } from './ports.js';
import type { ApiError } from '@/modules/shared/index.js';

const invalid = (): ApiError => ({
  type: 'InvalidInput',
  field: 'sourcePins',
  message:
    'Source pins require unique declared dimensions and canonical member codes belonging to each dimension',
});

/** Resolve exact pairs without distributing a shared member set across dimensions. */
export async function sourcePinsToSlots(
  repo: InsRepo,
  datasetCode: string,
  dimensions: readonly InsDimensionView[],
  sourcePins: readonly InsSourcePin[]
): Promise<Result<SlotPins, ApiError>> {
  // The physical source contract has seven classification slots, not a result cap.
  if (sourcePins.length > MAX_SLOTS) return err(invalid());
  const declared = new Map(
    dimensions
      .filter((d) => d.role === 'classification' && d.slotIndex !== null)
      .map((d) => [d.dimIndex, d.slotIndex])
  );
  const requested = new Map<number, number>();
  for (const pin of sourcePins) {
    const member = parseMemberCode(pin.memberCode);
    if (
      !Number.isInteger(pin.dimensionIndex) ||
      pin.dimensionIndex < 0 ||
      pin.dimensionIndex >= MAX_SLOTS ||
      !declared.has(pin.dimensionIndex) ||
      requested.has(pin.dimensionIndex) ||
      member === null ||
      String(member) !== pin.memberCode
    )
      return err(invalid());
    requested.set(pin.dimensionIndex, member);
  }
  if (requested.size === 0) return ok(new Map());
  const members = await repo.membersByIds(datasetCode, [...new Set(requested.values())]);
  if (members.isErr()) return err(members.error);
  const membership = new Set(members.value.map((m) => JSON.stringify([m.dimIndex, m.nomItemId])));
  const slots = new Map<number, readonly number[]>();
  for (const [dimension, member] of requested) {
    const slot = declared.get(dimension);
    if (slot === undefined || slot === null || !membership.has(JSON.stringify([dimension, member])))
      return err(invalid());
    slots.set(slot, [member]);
  }
  return ok(slots);
}
