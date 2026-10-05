# Chronos development secrets

This directory contains only strict-scope SealedSecret ciphertext for namespace
`transparenta-eu-dev`. Bitwarden Secrets Manager project `chronos` is the
plaintext authority.

Generate from this repository only:

```bash
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

## Local credential handling

Run the sealing command from this repository with explicit Chronos kubeconfig and
context. It checks the target, controller and Kustomization before requesting a
credential. On macOS it reads the current account's Keychain item
`transparenta-bws-access-token`; otherwise it prompts without echo in a terminal.
The token is passed only to the Bitwarden child process, never on the command line
or in files/logs. Normal sealing fetches only the registered Bitwarden record IDs
and verifies their project/key identity. Raw Secret JSON stays in memory and feeds
kubeseal through stdin. Only validated ciphertext is written. Generation does not
apply anything to Kubernetes. Never paste a token into a command or a chat.

The dev Deployment reads its Meili key (`PROD_MEILI_SEARCH_API_KEY`) from
`chronos-companies-dev-meilisearch-reader`, a registered strict SealedSecret whose
BWS record lives at the exact external project and key named in the registry. Its
Meili key UID is `799c052e-1d7e-5c39-8932-3a27e3affafe`, with only `search` and
`documents.get` (the search generation control read) on `entities_ngo_dev_20261001`.
It is a server-only credential, never exposed to a browser or other client. The
previous search-only NGO key, `chronos-ngo-dev-meilisearch-search-credentials`
(UID `a918377b-ce16-4074-929d-f99ca11dd800`), is no longer referenced by the
Deployment; its encrypted manifest is retained here for recovery, outside the
Bitwarden bulk-seal registry, and the key can be recovered by that UID through the
operator's existing Meili master custody. Do not replace or broaden the canonical
production search key.
