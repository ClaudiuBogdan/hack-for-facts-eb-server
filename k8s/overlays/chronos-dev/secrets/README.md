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

The `transparenta-eu-dev-resend` record holds the Phoenix development Resend API
credentials for Chronos development. The separate
`transparenta-eu-dev-mail-signing` record holds the Chronos-specific
`RESEND_WEBHOOK_SECRET` and the dev `UNSUBSCRIBE_HMAC_SECRET`.
The webhook listens for `email.delivered` at
`https://dev-chronos-api.transparenta.eu/api/v1/webhooks/resend`. The verified
receiver correlates Chronos welcome outboxes and persists the delivery
status and message ID. It acknowledges unrelated account events without
storing their payloads.

`NOTIFICATION_DELIVERY_ENABLED` defaults to `false`. Set it to `true` in
an environment to send one Funky welcome for each eligible new registration.
The worker looks up the registrant's verified primary email in Clerk, uses the
campaign sender when configured, and keeps a per-user outbox key. The queue and
recovery worker use a dedicated prefix and process only native welcome rows.
The receiver continues to process delivery receipts while sends are off.

Set `API_BASE_URL` and `PROD_CLIENT_BASE_URL` for the environment. Provide its
Clerk backend key, user DB, BullMQ TLS configuration, and Resend API key, sender,
and endpoint signing secret. Use `FUNKY_EMAIL_FROM_ADDRESS` when it has a
dedicated campaign sender. Allow verified HTTPS to `api.clerk.com` and
`api.resend.com`. At production cutover, use the existing production unsubscribe
signing key so earlier unsubscribe links continue to work.

For a scoped dev replay,
`CHRONOS_DEV_CAMPAIGN_WELCOME_OWNER` accepts only the approved Tester 1 Clerk
account. An eligible acceptance saves the welcome outbox in the registration
transaction; composition queues after commit. To replay a pending acceptance,
start one temporary process with the switch enabled and supply its original
`CHRONOS_DEV_CAMPAIGN_REPLAY_EVENT_ID` and
`CHRONOS_DEV_CAMPAIGN_REPLAY_ENTITY_CUI`. The saved audit event and current
terms must agree. Retain the outbox and keep the receiver available to process
the signed delivery receipt while sends are off.

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

`transparenta-prod-api-dev-credentials` (the procurement login's `PROCUREMENT_DATABASE_URL`, PRJ-54YB P4) is
listed under `externallySealed` in the registry: the owner's Codex lane seals it, deriving the URL in memory from a
BWS record that has no URL field, so `secrets:seal:chronos` never selects or writes it. The kustomization must list
exactly the registered and the externally sealed files; reseal this one on the owner's lane.
