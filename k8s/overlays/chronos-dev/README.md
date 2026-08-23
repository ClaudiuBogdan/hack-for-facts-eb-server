# Chronos development overlay

This source-only overlay renders the redesign-only, read-only Transparenta.eu
API workload for the future Chronos namespace `transparenta-eu-dev`. It is not
an installation instruction and has not been applied.

The overlay intentionally owns only the Deployment, Service, ServiceAccount,
ConfigMap, and PodDisruptionBudget. It excludes the Phoenix `VirtualService`,
all CNPG objects, Redis and BullMQ, PVCs, and their NetworkPolicies. Chronos
ingress remains centrally owned, while writable state and production-derived
read-only access remain in the separately approved manual data lane.

The Deployment overrides the image command with `dist/redesign-api.js`. This
entrypoint does not initialize the legacy budget, INS, user-data, Clerk webhook,
email, notification, BullMQ, campaign, or agent runtimes. It consumes only the
Chronos-local read-only production database plus read-only Meilisearch and
OpenSearch identities. ClickHouse is explicitly disabled for the initial
canary.

Secrets are generated independently from this repository by
`scripts/seal-bitwarden-secrets.mjs` and the non-secret
`secrets.registry.json`. The workload Kustomization excludes ciphertext; a
separate, narrowly scoped Argo secrets Application owns the `secrets/` path.

Before any sync:

- reconfirm the pinned image digest and prove it contains
  `dist/redesign-api.js`;
- generate and validate all registered strict Chronos ciphertext from the
  dedicated BWS project;
- prove all required service endpoints and side effects are fenced;
- pass the platform, registry, policy, recovery, and ingress gates in the
  Phoenix-to-Chronos application migration plan;
- pin the Argo Application to an exact reviewed commit SHA and keep manual
  sync, prune off, self-heal off, and deletion finalizers absent.

Render without applying:

```bash
kubectl kustomize k8s/overlays/chronos-dev
```

Expected kinds are one ConfigMap, Deployment, PodDisruptionBudget, Service,
and ServiceAccount. A render containing `VirtualService`, CNPG `Cluster`,
Redis, BullMQ, PVC, `HTTPRoute`, or a Secret is a failure.

The separate `secrets/` render must contain exactly four SealedSecrets and no
raw Secret.
