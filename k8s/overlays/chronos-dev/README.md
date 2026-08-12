# Chronos development overlay

This source-only overlay renders the Transparenta.eu API workload for the
future Chronos namespace `transparenta-eu-dev`. It is not an installation
instruction and has not been applied.

The overlay intentionally owns only the Deployment, Service, ServiceAccount,
ConfigMap, and PodDisruptionBudget. It excludes the Phoenix `VirtualService`,
all CNPG objects, Redis and BullMQ, PVCs, and their NetworkPolicies. Chronos
ingress remains centrally owned, while writable state and production-derived
read-only access remain in the separately approved manual data lane.

Before any sync:

- replace or reconfirm the pinned image digest;
- add independently resealed Chronos Secret declarations from Bitwarden;
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
