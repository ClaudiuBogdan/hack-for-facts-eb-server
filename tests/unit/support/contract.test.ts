import { afterAll, expect, it } from 'vitest';

import { describePortContract } from '../../support/index.js';

interface CounterPort {
  value: number;
}

const lifecycle: string[] = [];
let earlyAccessError: unknown;

describePortContract<CounterPort>(
  'CounterPort',
  ({ getPort, backend }) => {
    try {
      getPort();
    } catch (error: unknown) {
      earlyAccessError = error;
    }

    it('sets up the fake before reset and reports early access clearly', () => {
      expect(backend).toBe('fake');
      expect(earlyAccessError).toBeInstanceOf(Error);
      if (earlyAccessError instanceof Error) {
        expect(earlyAccessError.message).toContain(
          'CounterPort fake contract port is unavailable before fixture setup'
        );
      }
      expect(lifecycle).toEqual(['make', 'reset']);
      getPort().value = 9;
    });

    it('resets the same fixture before every test', () => {
      expect(lifecycle).toEqual(['make', 'reset', 'reset']);
      expect(getPort().value).toBe(0);
    });
  },
  {
    fake: () => {
      lifecycle.push('make');
      const port: CounterPort = { value: 0 };
      return {
        port,
        reset: () => {
          lifecycle.push('reset');
          port.value = 0;
        },
        teardown: () => {
          lifecycle.push('teardown');
        },
      };
    },
  }
);

const asyncLifecycle: string[] = [];

describePortContract<CounterPort>(
  'AsyncCounterPort',
  ({ getPort, backend }) => {
    it('supports asynchronous make, reset, and teardown', () => {
      expect(backend).toBe('fake');
      expect(asyncLifecycle).toEqual(['make', 'reset']);
      expect(getPort().value).toBe(0);
    });
  },
  {
    fake: async () => {
      await Promise.resolve();
      asyncLifecycle.push('make');
      const port: CounterPort = { value: 0 };
      return {
        port,
        reset: async () => {
          await Promise.resolve();
          asyncLifecycle.push('reset');
          port.value = 0;
        },
        teardown: async () => {
          await Promise.resolve();
          asyncLifecycle.push('teardown');
        },
      };
    },
  }
);

describePortContract<CounterPort>(
  'GatedRealPort',
  () => {
    it('never runs when the real backend gate is closed', () => {
      expect.unreachable('gated real suite must be skipped');
    });
  },
  {
    real: {
      make: () => {
        asyncLifecycle.push('real-make');
        return { port: { value: 0 } };
      },
      when: () => false,
    },
  }
);

afterAll(() => {
  expect(lifecycle).toEqual(['make', 'reset', 'reset', 'teardown']);
  expect(asyncLifecycle).toEqual(['make', 'reset', 'teardown']);
  expect(asyncLifecycle).not.toContain('real-make');
});
