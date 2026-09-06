# Chronos development overlay

This overlay renders the native Transparenta.eu API workload
deployed as an internal canary in the Chronos namespace
`transparenta-eu-dev`. Argo tracks `refs/heads/dev` with manual sync, prune off,
and self-heal off, so a branch update changes only the reviewed desired state
until a separate sync is approved.

The overlay intentionally owns only the Deployment, Service, ServiceAccount,
ConfigMap, and PodDisruptionBudget. It excludes the Phoenix `VirtualService`,
all CNPG objects, Redis and BullMQ, PVCs, and their NetworkPolicies. Chronos
ingress remains centrally owned, while writable state and production-derived
read-only access remain in the separately approved manual data lane.

The Deployment overrides the image command with `dist/redesign-api.js`. This
entrypoint reads native budget and INS from Chronos through read-only production
and search identities. Optional development Clerk authentication and the verified
user-deletion receiver use a separate restricted writable dev user database; see
[user-database/README.md](user-database/README.md). It never initializes schema or
mounts legacy email, notification, BullMQ, campaign or user-data writers. ClickHouse is explicitly disabled for the initial
canary.

Secrets are generated independently from this repository by
`scripts/seal-bitwarden-secrets.mjs` and the non-secret
`secrets.registry.json`. The workload Kustomization excludes ciphertext; a
separate, narrowly scoped Argo secrets Application owns the `secrets/` path.

Before any sync:

- confirm the inherited base image uses the exact Git SHA tag written by the
  existing dev CI and contains `dist/redesign-api.js`;
- confirm the existing SealedSecrets remain Synced and Healthy; normal image
  rollouts do not regenerate them or access BWS;
- prove all required service endpoints and side effects are fenced;
- pass the platform, registry, policy, recovery, and ingress gates in the
  Phoenix-to-Chronos application migration plan;
- keep the Argo Application on `refs/heads/dev` with manual sync, prune off,
  self-heal off, and deletion finalizers absent.

Render without applying:

```bash
kubectl kustomize k8s/overlays/chronos-dev
```

Expected kinds are one ConfigMap, Deployment, PodDisruptionBudget, Service,
and ServiceAccount. A render containing `VirtualService`, CNPG `Cluster`,
Redis, BullMQ, PVC, `HTTPRoute`, or a Secret is a failure.

The separate `secrets/` render must contain exactly six SealedSecrets and no
raw Secret.
