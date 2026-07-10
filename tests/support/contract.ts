import { afterAll, beforeAll, beforeEach, describe } from 'vitest';

export interface PortFixture<Port> {
  port: Port;
  reset?(): Promise<void> | void;
  teardown?(): Promise<void> | void;
}

export type PortFixtureFactory<Port> = () => Promise<PortFixture<Port>> | PortFixture<Port>;

export interface PortContractContext<Port> {
  getPort(): Port;
  backend: 'fake' | 'real';
}

export type PortContractCases<Port> = (context: PortContractContext<Port>) => void;

interface PortContractBackends<Port> {
  fake?: PortFixtureFactory<Port>;
  real?: {
    make: PortFixtureFactory<Port>;
    when?: () => boolean;
  };
}

type SuiteDefinition = (name: string, factory: () => void) => unknown;

const defineBackendContract = <Port>(
  name: string,
  cases: PortContractCases<Port>,
  backend: 'fake' | 'real',
  make: PortFixtureFactory<Port>,
  defineSuite: SuiteDefinition
): void => {
  defineSuite(`${name} contract [${backend}]`, () => {
    let fixture: PortFixture<Port> | undefined;

    beforeAll(async () => {
      fixture = await make();
    });

    beforeEach(async () => {
      if (fixture === undefined) {
        throw new Error(`${name} ${backend} contract fixture is unavailable before reset`);
      }
      await fixture.reset?.();
    });

    afterAll(async () => {
      if (fixture !== undefined) {
        try {
          await fixture.teardown?.();
        } finally {
          fixture = undefined;
        }
      }
    });

    cases({
      getPort: (): Port => {
        if (fixture === undefined) {
          throw new Error(
            `${name} ${backend} contract port is unavailable before fixture setup or after teardown`
          );
        }
        return fixture.port;
      },
      backend,
    });
  });
};

export function describePortContract<Port>(
  name: string,
  cases: PortContractCases<Port>,
  backends: PortContractBackends<Port>
): void {
  if (backends.fake === undefined && backends.real === undefined) {
    throw new Error(`${name} contract requires at least one backend`);
  }

  if (backends.fake !== undefined) {
    defineBackendContract(name, cases, 'fake', backends.fake, describe);
  }

  if (backends.real !== undefined) {
    const real = backends.real;
    const defineRealSuite = real.when === undefined ? describe : describe.skipIf(!real.when());
    defineBackendContract(name, cases, 'real', real.make, defineRealSuite);
  }
}
