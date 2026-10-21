import { ELECTION_FAMILIES, type ElectionFamily, type ElectionPlaceType } from './types.js';

/**
 * Key grammars of the scrapper's serving model (its SERVING_MODEL_DESIGN §4).
 * An event key is `ro:<family>:<year>`, or `ro:<family>:<year>:<first ballot
 * date>` for a further event of that family and year: family and year are
 * parts of the key by that grammar, not inferred from data. A place key is
 * `uat:<SIRUTA>`, `county:<code>`, `diaspora` or `national`.
 */

const EVENT_KEY = /^ro:([a-z]+):([0-9]{4})(?::[0-9]{4}-[0-9]{2}-[0-9]{2})?$/u;

export interface EventKeyParts {
  readonly family: ElectionFamily;
  readonly year: number;
}

/** Null when the key does not follow the grammar or names an unknown family. */
export const parseEventKey = (eventKey: string): EventKeyParts | null => {
  const match = EVENT_KEY.exec(eventKey);
  const family = match?.[1];
  const year = match?.[2];
  if (family === undefined || year === undefined) return null;
  if (!(ELECTION_FAMILIES as readonly string[]).includes(family)) return null;
  return { family: family as ElectionFamily, year: Number(year) };
};

export interface PlaceKeyParts {
  readonly placeType: ElectionPlaceType;
  readonly sirutaCode: string | null;
  readonly countyCode: string | null;
}

const UAT_KEY = /^uat:([1-9][0-9]*)$/u;
const COUNTY_KEY = /^county:([A-Z]{1,2})$/u;

/** Null when the key is not a place key. */
export const parsePlaceKey = (placeKey: string): PlaceKeyParts | null => {
  if (placeKey === 'national' || placeKey === 'diaspora')
    return { placeType: placeKey, sirutaCode: null, countyCode: null };
  const uat = UAT_KEY.exec(placeKey)?.[1];
  if (uat !== undefined) return { placeType: 'uat', sirutaCode: uat, countyCode: null };
  const county = COUNTY_KEY.exec(placeKey)?.[1];
  if (county !== undefined) return { placeType: 'county', sirutaCode: null, countyCode: county };
  return null;
};
