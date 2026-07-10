import { expect, it } from 'vitest';

import { canonicalJsonStringify as canonicalCommon } from '@/common/canonical-json/index.js';
import { canonicalJsonStringify as canonicalReExport } from '@/modules/notification-platform/core/shared/canonical-json.js';

import { expectOk } from '../../support/result.js';

it('common canonical JSON and the notification-platform re-export are identical', () => {
  const value = { z: [3, { b: true, a: null }], a: 'first' };
  expect(expectOk(canonicalCommon(value))).toBe(expectOk(canonicalReExport(value)));
  expect(expectOk(canonicalCommon(value))).toBe('{"a":"first","z":[3,{"a":null,"b":true}]}');
});
