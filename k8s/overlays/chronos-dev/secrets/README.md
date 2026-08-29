# Chronos development secrets

This directory contains only strict-scope SealedSecret ciphertext for namespace
`transparenta-eu-dev`. Bitwarden Secrets Manager project `chronos` is the
plaintext authority.

Generate from this repository only:

```bash
BWS_ACCESS_TOKEN="$(security find-generic-password \
  -a "$USER" \
  -s chronos-bws-access-token \
  -w)" \
  pnpm secrets:seal:chronos -- \
    --kubeconfig "$HOME/.kube/chronos.yaml" \
    --context chronos
```

The generator verifies the Chronos API identity and Ready durable node, checks
the controller before BWS access, resolves exact JSON field contracts, streams
raw Secret JSON to `kubeseal`, validates every ciphertext against the live
controller, and replaces no output until the complete selected batch passes.

Never add plaintext Secret YAML, PEM, passwords, tokens, kubeconfigs, BWS
exports, or environment files here. Workload Kustomization deliberately does
not import this directory; a separate narrowly scoped Argo secrets Application
owns it.
