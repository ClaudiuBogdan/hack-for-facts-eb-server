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
This Clerk instance also delivers events to the Phoenix development endpoint.
Run an end-to-end deletion test only when the test account's lifecycle events
route exclusively to Chronos dev. With shared event routing, use a signed
synthetic probe inside the Chronos dev API pod to exercise the receiver.

The receiver verifies the Svix signature and runs the anonymizer. Check that an
invalid signature is refused. Owner tombstones block stale-session writes after
deletion starts. Keep the audit tombstone and any soft-deleted, scrubbed records
as evidence.

### Verify the development flow

1. In Clerk, open **Configure → Developers → Webhooks** in the development
   instance. Open the existing Chronos endpoint and check the URL and
   `user.deleted` subscription. Its `CLERK_WEBHOOK_SIGNING_SECRET` is in the
   dev application Bitwarden record.
2. Confirm Chronos serves `GET` and `PUT /api/v1/learning/progress`. With
   Chronos-only event routing verified, create a disposable Clerk dev user and sign in at
   [dev-chronos.transparenta.eu](https://dev-chronos.transparenta.eu/). Sign
   up for Funky and confirm the registration survives in a fresh browser
   session after signing in again. This proves it reached the server.
3. Delete only the disposable user. In the Chronos endpoint's **Message
   Attempts**, confirm the actual `user.deleted` returned 200. Use the message
   ID to match the API's completed anonymization log. Verify the test user's
   campaign records are anonymized and a stale owner write is rejected.
   Replay only that event to the Chronos endpoint and confirm the
   anonymized state is unchanged. Keep the deletion audit tombstone.
4. When running a delivery test, send only to `delivered+test1@resend.dev`.
   Verify the Resend delivery event separately from Clerk sign-in and deletion.
   Keep the existing Tester 1 account for mail tests.

On 2026-11-16, Clerk's **Send Example** reached the public receiver. The
receiver verified the signature and returned 400 because the example omitted
`instance_id` (message `msg_3MBI2d3aoO0j9a3drFp3ZhMQJLj`). A schema-complete
signed probe inside the dev API pod returned 200 for the synthetic ID and 200 on
replay, with anonymization completion logged for both attempts. The probe had
zero user records.

After the learning-progress rollout on 2026-11-16, a real disposable development
Clerk account signed in through the Clerk Frontend API and registered for Funky
through the Chronos dev API. A separate GET returned the saved registration.
Clerk deletion delivered event `msg_3MBL5w497uBt1BrpwLuNo2sVUUR` to Chronos.
A read-only check confirmed zero rows under the original owner, one retained
registration with its value and audit events cleared, two inactive anonymized
notification preferences, and the matching deletion audit record. The old
session could read zero records and received 403 on a subsequent write. The
test covered the API flow. Chronos email delivery remains a separate test.

### Connect production at cutover

Run these steps once the production cutover is approved and Chronos is ready to
own user-data writes.

1. In the existing production Clerk instance, confirm the production client
   origin, publishable key, and matching API JWT issuer and verification key.
   Prepare the API receiver against the production user DB, with sends paused.
2. If Cloudflare moves the existing webhook URL to Chronos, preserve that
   endpoint's signing secret and event subscriptions. If the URL changes,
   create the production endpoint with the required subscriptions and use its
   own signing secret. Store the selected secret as
   `CLERK_WEBHOOK_SIGNING_SECRET` in the production application Bitwarden
   record. Seal for the exact production Secret name and namespace, then
   sync the ciphertext and restart the API to load it.
3. Route webhook traffic to Chronos once it owns writes. Enable
   `user.created` delivery only when its handler and email controls are
   ready. Reconcile the Clerk delivery log across the maintenance window and
   confirm the corresponding application effects before enabling sends.

See the [Clerk webhook setup guide](https://clerk.com/docs/guides/development/webhooks/syncing)
and [user-data anonymization rules](../../../../docs/USER-DATA-ANONYMIZATION.md).

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
