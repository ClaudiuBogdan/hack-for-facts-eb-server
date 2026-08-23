# Chronos GitOps foundation canary

This path is an intentionally disposable, side-effect-free source for the
first Chronos Argo CD reconciliation test.

It renders exactly one namespaced `ConfigMap`. It contains no workload image,
Pod, Service, ServiceAccount, Secret, volume, route, RBAC object, cluster-scoped
resource, hostname, external call, or application configuration.

The Chronos platform source creates the restricted namespace and the exact
AppProject/Application boundary. Argo tracks the immutable commit containing
this path, starts with manual sync, and has neither prune nor self-heal enabled.

The canary validates:

- GitHub repository access and Kustomize rendering;
- an initial `OutOfSync` observation before manual sync;
- creation of only `ConfigMap/chronos-gitops-canary`;
- harmless live drift detection without automatic repair; and
- manual restoration from the pinned Git commit.

Deleting the branch, Application, ConfigMap, or namespace is a separate cleanup
operation and must not be inferred from successful validation.
