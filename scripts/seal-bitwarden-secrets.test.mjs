import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertSafeSealedYaml,
  assertSealedDocument,
  bitwardenLocation,
  buildSecretDocument,
  createRedactor,
  normalizeRegistry,
  fetchBitwardenSecrets,
  parseJson,
  selectSecrets,
  resolveSecrets,
  parseSecretFields,
} from './seal-bitwarden-secrets.mjs';

const definition = {
  name: 'app-runtime',
  bitwardenSecretId: 'record-id',
  type: 'Opaque',
  render: 'stringData',
  requiredFields: ['URL', 'MULTILINE', 'LEADING_DASH'],
  labels: {},
  annotations: {},
};

test('registry requires an exact strict target', () => {
  const registry = normalizeRegistry({
    version: 1,
    target: {
      namespace: 'transparenta-eu-dev',
      expectedContext: 'chronos',
      expectedServer: 'https://chronos:6443',
      requiredReadyNode: 'chronos',
      forbiddenNodes: ['phoenix', 'griffin'],
    },
    bitwarden: { projectId: 'project', basePrefix: '/secrets/chronos/dev/app' },
    sealedSecrets: {
      controllerName: 'sealed-secrets-controller',
      controllerNamespace: 'kube-system',
      scope: 'strict',
      syncWave: '-8',
    },
    output: { directory: 'secrets', kustomization: 'secrets/kustomization.yaml' },
    secrets: [definition],
  });
  assert.equal(registry.sealedSecrets.scope, 'strict');
  assert.equal(registry.target.expectedServer, 'https://chronos:6443');
});

test('BWS JSON fields must match the registry exactly', () => {
  const fields = parseSecretFields(
    '/record',
    JSON.stringify({ URL: 'https://example.test', MULTILINE: 'a\nb', LEADING_DASH: '---value' }),
    definition.requiredFields
  );
  assert.equal(fields.LEADING_DASH, '---value');
  assert.throws(
    () =>
      parseSecretFields(
        '/record',
        JSON.stringify({ URL: 'x', EXTRA: 'y' }),
        definition.requiredFields
      ),
    /field contract mismatch/u
  );
});

test('raw Secret remains in memory and preserves multiline and leading-dash values', () => {
  const document = buildSecretDocument(definition, 'transparenta-eu-dev', {
    URL: 'https://example.test',
    MULTILINE: 'line1\nline2',
    LEADING_DASH: '-----BEGIN TEST-----',
  });
  assert.equal(document.kind, 'Secret');
  assert.equal(document.stringData.MULTILINE, 'line1\nline2');
  assert.equal(document.stringData.LEADING_DASH, '-----BEGIN TEST-----');
});

test('redactor removes values even from child error text', () => {
  const redact = createRedactor(['short', 'line1\nline2', '-----BEGIN TEST-----']);
  const output = redact('short line1\nline2 -----BEGIN TEST-----');
  assert.equal(output.includes('short'), false);
  assert.equal(output.includes('line1'), false);
  assert.equal(output.includes('BEGIN TEST'), false);
});

test('sealed output rejects raw kinds, fields, and resolved plaintext', () => {
  const redact = createRedactor(['super-secret']);
  assert.doesNotThrow(() =>
    assertSafeSealedYaml(
      'apiVersion: bitnami.com/v1alpha1\nkind: SealedSecret\nmetadata:\n  name: ok\n',
      redact
    )
  );
  assert.throws(
    () => assertSafeSealedYaml('apiVersion: v1\nkind: Secret\nstringData:\n  A: x\n', redact),
    /raw Secret|not a SealedSecret/u
  );
  assert.throws(
    () =>
      assertSafeSealedYaml(
        'apiVersion: bitnami.com/v1alpha1\nkind: SealedSecret\nspec:\n  encryptedData:\n    A: super-secret\n',
        redact
      ),
    /resolved plaintext/u
  );
});

test('selected records are resolved before fetching credentials', () => {
  assert.throws(() => selectSecrets({ secrets: [definition] }, ['unknown']), /Unknown Secret/);
  assert.deepEqual(selectSecrets({ secrets: [definition] }, [definition.name]), [definition]);
});

test('Bitwarden fetches only exact selected IDs, passing token only in child env', async () => {
  const calls = [];
  const record = {
    id: definition.bitwardenSecretId,
    key: '/record',
    projectId: 'project',
    value: '{}',
  };
  const result = await fetchBitwardenSecrets('private-token', [definition], async (...args) => {
    calls.push(args);
    return { exitCode: 0, stdout: JSON.stringify(record) };
  });
  assert.deepEqual(result, [record]);
  assert.deepEqual(calls[0][1], [
    'secret',
    'get',
    definition.bitwardenSecretId,
    '--output',
    'json',
  ]);
  assert.equal(calls[0][2].environment.BWS_ACCESS_TOKEN, 'private-token');
  assert.equal(calls[0][1].includes('private-token'), false);
});

test('wrong identity and sensitive Bitwarden failures fail closed', async () => {
  await assert.rejects(
    fetchBitwardenSecrets('private-token', [definition], async () => ({
      exitCode: 0,
      stdout: '{"id":"other"}',
    })),
    /identity mismatch/
  );
  await assert.rejects(
    fetchBitwardenSecrets('private-token', [definition], async () => ({
      exitCode: 1,
      stdout: 'private-token',
      stderr: 'private-token',
    })),
    (error) => {
      assert.equal(error.message.includes('private-token'), false);
      return true;
    }
  );
  assert.throws(
    () =>
      resolveSecrets(
        { bitwarden: { basePrefix: '/record', projectId: 'approved' } },
        [
          {
            id: definition.bitwardenSecretId,
            key: '/record/app-runtime',
            projectId: 'wrong',
            value: '{}',
          },
        ],
        [definition]
      ),
    /approved BWS project/
  );
});

// ── per-entry BWS location overrides ─────────────────────────────────────────

const GLOBAL_PROJECT = 'a0653772-00bb-4826-a75b-b4af014a8fee';
const EXTERNAL_PROJECT = '37ddf263-de34-4e7e-aec5-b412015d98cc';
const EXTERNAL_KEY =
  '/secrets/transparenta-eu-etl/prod/transparenta-eu-etl-prod/transparenta-eu-etl-infra/transparenta-companies-clickhouse-reader';
const READER_ID = '888f24cd-c8df-4fc4-88aa-b4d700e02103';

const registryWith = (entries) =>
  normalizeRegistry({
    version: 1,
    target: {
      namespace: 'transparenta-eu-dev',
      expectedContext: 'chronos',
      expectedServer: 'https://chronos:6443',
      requiredReadyNode: 'chronos',
      forbiddenNodes: ['phoenix', 'griffin'],
    },
    bitwarden: { projectId: GLOBAL_PROJECT, basePrefix: '/secrets/chronos/dev/app/' },
    sealedSecrets: {
      controllerName: 'sealed-secrets-controller',
      controllerNamespace: 'kube-system',
      scope: 'strict',
      syncWave: '-8',
    },
    output: { directory: 'secrets', kustomization: 'secrets/kustomization.yaml' },
    secrets: entries,
  });

const readerEntry = (over = {}) => ({
  name: 'chronos-companies-clickhouse-reader-credentials',
  type: 'kubernetes.io/basic-auth',
  render: 'stringData',
  requiredFields: ['username', 'password'],
  bitwardenSecretId: READER_ID,
  bitwardenProjectId: EXTERNAL_PROJECT,
  bitwardenRecordKey: EXTERNAL_KEY,
  ...over,
});

const readerValue = JSON.stringify({ username: 'companies_reader', password: 'not-real' });

test('entries without overrides keep the registry-wide project and <prefix>/<name> key', () => {
  const registry = registryWith([{ ...definition, bitwardenSecretId: 'record-id' }]);
  const [secret] = registry.secrets;
  assert.equal(Object.hasOwn(secret, 'bitwardenProjectId'), false);
  assert.equal(Object.hasOwn(secret, 'bitwardenRecordKey'), false);
  assert.deepEqual(bitwardenLocation(registry, secret), {
    recordKey: '/secrets/chronos/dev/app/app-runtime',
    projectId: GLOBAL_PROJECT,
  });
  const [resolved] = resolveSecrets(
    registry,
    [
      {
        id: 'record-id',
        key: '/secrets/chronos/dev/app/app-runtime',
        projectId: GLOBAL_PROJECT,
        value: JSON.stringify({ URL: 'u', MULTILINE: 'm', LEADING_DASH: 'l' }),
      },
    ],
    registry.secrets
  );
  assert.equal(resolved.recordKey, '/secrets/chronos/dev/app/app-runtime');
});

test('an override resolves only the exact external record', () => {
  const registry = registryWith([
    readerEntry({ bitwardenProjectId: EXTERNAL_PROJECT.toUpperCase() }),
  ]);
  const [secret] = registry.secrets;
  assert.equal(secret.bitwardenProjectId, EXTERNAL_PROJECT);
  const [resolved] = resolveSecrets(
    registry,
    [{ id: READER_ID, key: EXTERNAL_KEY, projectId: EXTERNAL_PROJECT, value: readerValue }],
    registry.secrets
  );
  assert.equal(resolved.recordKey, EXTERNAL_KEY);
  assert.deepEqual(Object.keys(resolved.fields).sort(), ['password', 'username']);
});

test('a wrong id, key or project fails before any value is parsed', () => {
  const registry = registryWith([readerEntry()]);
  // Unparsable values prove the location checks run first.
  const record = {
    id: READER_ID,
    key: EXTERNAL_KEY,
    projectId: EXTERNAL_PROJECT,
    value: '{not json',
  };
  const cases = [
    [{ ...record, id: 'other-id' }, /must resolve to exactly one BWS record/u],
    [
      { ...record, key: `/secrets/chronos/dev/app/${readerEntry().name}` },
      /must resolve to exactly one BWS record/u,
    ],
    [{ ...record, projectId: GLOBAL_PROJECT }, /not in the approved BWS project/u],
  ];
  for (const [candidate, expected] of cases) {
    assert.throws(() => resolveSecrets(registry, [candidate], registry.secrets), expected);
  }
  // Two records claiming the same identity and key are ambiguous: refused.
  assert.throws(
    () =>
      resolveSecrets(
        registry,
        [
          { ...record, value: readerValue },
          { ...record, value: readerValue },
        ],
        registry.secrets
      ),
    /exactly one BWS record/u
  );
});

test('malformed overrides are refused when the registry is loaded', () => {
  const malformed = [
    { bitwardenProjectId: '' },
    { bitwardenProjectId: 'project' },
    { bitwardenProjectId: 37 },
    { bitwardenProjectId: null },
    { bitwardenRecordKey: '' },
    { bitwardenRecordKey: 'secrets/relative' },
    { bitwardenRecordKey: '/secrets/../other' },
    { bitwardenRecordKey: '/secrets//double' },
    { bitwardenRecordKey: '/secrets/trailing/' },
    { bitwardenRecordKey: '/secrets/with space' },
    { bitwardenRecordKey: ['/secrets/a'] },
  ];
  for (const over of malformed) {
    assert.throws(() => registryWith([readerEntry(over)]), /bitwarden(ProjectId|RecordKey)/u);
  }
});

test('overrides never reach the Kubernetes Secret or its strict scope', () => {
  const registry = registryWith([readerEntry()]);
  const document = buildSecretDocument(registry.secrets[0], registry.target.namespace, {
    username: 'companies_reader',
    password: 'not-real',
  });
  assert.equal(document.metadata.name, 'chronos-companies-clickhouse-reader-credentials');
  assert.equal(document.metadata.namespace, 'transparenta-eu-dev');
  assert.equal(document.type, 'kubernetes.io/basic-auth');
  assert.equal(JSON.stringify(document).includes(EXTERNAL_KEY), false);
  assert.equal(JSON.stringify(document).includes(EXTERNAL_PROJECT), false);
  assert.equal(registry.sealedSecrets.scope, 'strict');
});

const MEILI_READER_ID = '9ecc70be-90cf-4f66-8dd4-b4d901605f40';
const MEILI_READER_KEY =
  '/secrets/transparenta-eu-etl/prod/transparenta-eu-dev/hack-for-facts-eb-server/chronos-companies-dev-meilisearch-reader';

test('the committed Chronos registry names the companies readers at their external records', async () => {
  const registry = normalizeRegistry(
    parseJson(
      await readFile(
        new URL('../k8s/overlays/chronos-dev/secrets.registry.json', import.meta.url),
        'utf8'
      ),
      'secret registry'
    )
  );
  const reader = registry.secrets.find(
    (entry) => entry.name === 'chronos-companies-clickhouse-reader-credentials'
  );
  const meiliReader = registry.secrets.find(
    (entry) => entry.name === 'chronos-companies-dev-meilisearch-reader'
  );
  assert.deepEqual(
    {
      id: reader?.bitwardenSecretId,
      type: reader?.type,
      requiredFields: reader?.requiredFields,
      location: reader && bitwardenLocation(registry, reader),
    },
    {
      id: READER_ID,
      type: 'kubernetes.io/basic-auth',
      requiredFields: ['username', 'password'],
      location: { recordKey: EXTERNAL_KEY, projectId: EXTERNAL_PROJECT },
    }
  );
  assert.deepEqual(
    {
      id: meiliReader?.bitwardenSecretId,
      type: meiliReader?.type,
      requiredFields: meiliReader?.requiredFields,
      location: meiliReader && bitwardenLocation(registry, meiliReader),
    },
    {
      id: MEILI_READER_ID,
      type: 'Opaque',
      requiredFields: ['apiKey'],
      location: { recordKey: MEILI_READER_KEY, projectId: EXTERNAL_PROJECT },
    }
  );
  // Every other entry keeps the registry-wide defaults.
  for (const entry of registry.secrets.filter(
    (candidate) => candidate !== reader && candidate !== meiliReader
  )) {
    assert.equal(Object.hasOwn(entry, 'bitwardenProjectId'), false);
    assert.equal(Object.hasOwn(entry, 'bitwardenRecordKey'), false);
  }
});

const sealed = () => ({
  apiVersion: 'bitnami.com/v1alpha1',
  kind: 'SealedSecret',
  metadata: { name: definition.name, namespace: 'transparenta-eu-dev' },
  spec: {
    encryptedData: Object.fromEntries(
      definition.requiredFields.map((key) => [key, 'encrypted-value'])
    ),
    template: {
      metadata: { name: definition.name, namespace: 'transparenta-eu-dev' },
      type: 'Opaque',
    },
  },
});

test('strict sealed contract rejects identity swaps, broader scope, raw fields and incomplete ciphertext', () => {
  assert.doesNotThrow(() => assertSealedDocument(sealed(), definition, 'transparenta-eu-dev'));
  const corruptions = [
    (doc) => {
      doc.metadata.namespace = 'production';
    },
    (doc) => {
      doc.spec.template.metadata.name = 'different';
    },
    (doc) => {
      doc.spec.template.metadata.namespace = 'production';
    },
    (doc) => {
      doc.spec.template.type = 'kubernetes.io/dockerconfigjson';
    },
    (doc) => {
      delete doc.spec.encryptedData.URL;
    },
    (doc) => {
      doc.spec.encryptedData.URL = '';
    },
    (doc) => {
      doc.spec.encryptedData.URL = null;
    },
    (doc) => {
      doc.spec.encryptedData.extra = 'encrypted';
    },
    ...['data', 'stringData'].flatMap((key) => [
      (doc) => {
        doc[key] = {};
      },
      (doc) => {
        doc.spec[key] = {};
      },
      (doc) => {
        doc.spec.template[key] = {};
      },
    ]),
    ...['cluster-wide', 'namespace-wide'].flatMap((scope) => [
      (doc) => {
        doc.metadata.annotations = { ['sealedsecrets.bitnami.com/' + scope]: 'true' };
      },
      (doc) => {
        doc.spec.template.metadata.annotations = { ['sealedsecrets.bitnami.com/' + scope]: 'true' };
      },
    ]),
  ];
  for (const corrupt of corruptions) {
    const doc = sealed();
    corrupt(doc);
    assert.throws(
      () => assertSealedDocument(doc, definition, 'transparenta-eu-dev'),
      /metadata contract failed/
    );
  }
});
