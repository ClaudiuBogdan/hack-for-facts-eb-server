import { type IdGenerator } from '@/common/ports/id-generator.js';

export interface SequentialIds extends IdGenerator {
  /** Next id without consuming it. */
  peek(): string;
  /** All ids issued so far, in order. */
  issued(): readonly string[];
  reset(): void;
}

/** Yields `${prefix}-1`, `${prefix}-2`, and so on using a per-instance counter. */
export function makeSequentialIds(prefix = 'id'): SequentialIds {
  let counter = 0;
  const issuedIds: string[] = [];

  const idAt = (position: number): string => `${prefix}-${String(position)}`;

  return {
    newId: (): string => {
      counter += 1;
      const id = idAt(counter);
      issuedIds.push(id);
      return id;
    },
    peek: (): string => idAt(counter + 1),
    issued: (): readonly string[] => [...issuedIds],
    reset: (): void => {
      counter = 0;
      issuedIds.length = 0;
    },
  };
}
