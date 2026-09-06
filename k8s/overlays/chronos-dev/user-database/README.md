# Isolated development user database

This manually applied lane owns only the new Chronos development CNPG cluster,
20 GiB encrypted volume and two narrow NetworkPolicies. It is separate from the
workload Argo application and from the read-only `transparenta_prod` serving DB.
It never uses a Phoenix database. No user-owned records were copied from Phoenix.

## Identity and storage

- Context `chronos`, API `https://chronos:6443`, namespace `transparenta-eu-dev`.
- Cluster `transparenta-eu-dev-user-db`, database `transparenta_dev_userdata`.
- Bootstrap owner `transparenta_dev_userdata_owner`; application role
  `transparenta_dev_userdata_app` has CONNECT, schema USAGE, table DML and sequence
  USAGE/SELECT. It cannot create schemas/tables, truncate, create roles/databases,
  replicate, bypass RLS or become superuser.
- PV `transparenta-eu-dev-user-db-data`, prebound PVC
  `transparenta-eu-dev-user-db-1`, node `chronos`, storage class
  `chronos-local-encrypted`, reclaim policy **Retain**.
- Host directory `/var/lib/chronos-encrypted/pv/transparenta-eu-dev/user-db-data`
  is owned by UID/GID 26 with mode 0700. Its parent mount was verified as
  `/dev/mapper/chronos-sensitive` before creation.
- One instance; **no backup is configured or verified for this dev database**.
  Retain protects against automatic volume deletion, not node/disk loss. Do not
  promise durable recovery from the manifests alone.

The platform quota separately permits one PVC, 20 GiB requested storage and one
bootstrap Job. Its source is server-agent's
`chronos/kubernetes/application-provisioning/transparenta-dev/manifests/quota-limitrange.yaml`.
Existing platform `allow-dns` and `server-data-egress` policies remain required:
NetworkPolicy permissions combine additively. The database-side policy allows
only same-namespace API pods on 5432 and CNPG operator monitoring on 8000.

## Fresh bootstrap only

On 2026-09-06 the database had **zero public relations**. The existing
`src/infra/database/user/schema.sql` was applied inside one transaction, with
checks for the exact database, current user `postgres`, no public relations of
any kind, and an existing restricted app role. The wrapper set a 60-second
statement timeout, revoked PUBLIC database access/schema CREATE, and granted the
app role the privileges listed above. The result was 30 base tables.

Evidence: full DDL SHA-256
`4d791ff3e4404393add4f82378ea0305dc30358b0ef207160ac32a649f0bc6e3`;
executed guarded wrapper SHA-256
`13c287e2e2ddca16e7959eabd7187725cae3c0cc7fce8462df0f64df26bcb219`.
The local execution record is
`/private/tmp/chronos-full-migration-20260905/dev-user-db-bootstrap.sql` and its
`.log` companion. These are evidence, not a deployment dependency.

**Never rerun the full schema on a populated database.** It contains legacy DROP
statements. Normal startup only probes the audit relation; it does not initialize
or migrate user storage. Future schema changes require explicit additive DDL and
review. Recovery/bootstrap on another empty target must repeat the identity,
empty-relation and least-privilege guards in the same transaction as the DDL.
Do not apply this lane blindly to an existing cluster/PVC/PV: inventory and
confirm ownership and the encrypted mount first.

## Secret custody and TLS

The registry in the parent directory owns three separate dev records: application
configuration, DB bootstrap credentials and restricted DB application credentials.
Use `pnpm secrets:seal:chronos -- --kubeconfig "$HOME/.kube/chronos.yaml" --context chronos`.
The generator reads the BWS token from macOS Keychain in memory, fetches exact
registered IDs and emits only namespace/name-bound ciphertext. Never store tokens,
passwords, plaintext env exports or the CNPG CA private key in this checkout.

The API mounts only `ca.crt` from CNPG's `transparenta-eu-dev-user-db-ca` Secret and
uses the restricted app Secret's URI. TLS verifies both CA and hostname. Local
validation uses a loopback SSH tunnel and the same public CA certificate, with
`USER_DATA_DB_TLS_SERVERNAME` set to the original service DNS name. Keep credentials
in launcher memory; never write a local env file for this lane.

Verified on 2026-09-06 from both the local tunnel and an actual dev API pod:
password authentication, `pg_stat_ssl.ssl=true`, a rolled-back map INSERT, and
permission-denied CREATE TABLE/TRUNCATE. Public readiness includes user storage
without publishing connection errors.

## Clerk deletion

Development instance `ins_31T65W6uWDSOP50gv9nKtP64LUI` uses endpoint
`ep_3IxuOd01ZPaX2Z1BFyUBCM1cTEF`, subscribed only to `user.deleted`, at
`https://dev-chronos-api.transparenta.eu/api/v1/webhooks/clerk`.
The existing Phoenix development endpoint is unchanged. The signing secret is in
the dev app BWS record; no real Clerk user is deleted for acceptance tests.

The native receiver uses the existing Svix verifier and anonymizer. Saved-map
writes remain separately mounted work. Owner tombstones prevent stale-token
writes after deletion begins. Live acceptance creates only a synthetic map owner,
checks invalid signatures, verifies anonymization and replay, and retains one audit row
per probe; the scrubbed, soft-deleted map row also remains. Local receiver
acceptance passed; public receiver deployment is a separate rollout gate. Audit tombstones are intentionally not cleaned up.

## Rollback and recovery

To disable this optional runtime, remove its DB URL/CA configuration and webhook
signing-secret environment entry together, roll back the reviewed dev workload,
and disable only the new Chronos webhook endpoint. Do not delete the database,
PVC, PV, credentials or audit tombstones. Workload rollbacks never run schema SQL.

For a lost claim, preserve the Retain PV and encrypted directory; inspect bindings,
CNPG metadata and PostgreSQL state before an approved rebind. Never clear a claim
reference, initialize over the retained directory or change its ownership as an
automatic repair. Restore from backup only after a backup actually exists and its
restore has been verified.
