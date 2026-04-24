# Prompt: Global Unsubscribe, Campaign Global, and Manual Opt-In Cascades

## Background

We have two different "global" notification controls and they must not be conflated:

1. Platform/system global unsubscribe: `global_unsubscribe`
   - System-managed.
   - Used by one-click/token unsubscribe through `unsubscribeViaToken()` and `NotificationsRepository.deactivateGlobalUnsubscribe()`.
   - Means the user disabled email notifications globally.
   - Must disable every notification preference for that user, including campaign globals.

2. Campaign global preference: `funky:notification:global`
   - User-visible master preference for the Funky/public-debate campaign.
   - Updated through the notification preferences API:

- `PATCH /api/v1/notifications/:id`
- `PUT /api/v1/notifications/:id`

The route calls `updateNotification()` in:

- `src/modules/notifications/core/usecases/update-notification.ts`

When the updated notification is the Funky/public-debate campaign master preference (`funky:notification:global`), the use case delegates to:

- `NotificationsRepository.updateCampaignGlobalPreference()`
- implemented by `src/modules/notifications/shell/repo/notifications-repo.ts`

Current campaign behavior cascades the same `is_active` value only to `funky:notification:entity_updates`. That part is campaign-scoped, but it also re-enables entity subscriptions when the campaign global is enabled, which can override user-specific campaign opt-outs.

Current system global unsubscribe behavior creates/updates the `global_unsubscribe` row, but it does not also deactivate the user's existing notification preference rows. Delivery checks still skip globally unsubscribed users, but the preferences state can remain misleading and campaign globals can remain active.

There is also an opt-in gap: if a user manually enables a notification while `global_unsubscribe` is still disabled, the notification row can become active but delivery remains blocked by the system global unsubscribe. The manual opt-in path must re-enable the required parent/global rows so the newly enabled notification can actually be delivered.

## Goal

Implement the correct two-level disable model:

1. When the platform/system global unsubscribe is applied (`global_unsubscribe` with email disabled), update/create that row and disable all notification preferences for the same user in one database transaction. This includes campaign global rows such as `funky:notification:global`, campaign entity subscriptions, newsletters, and alerts.

2. When the Funky campaign global is disabled (`funky:notification:global` with `isActive: false`), update that row and disable campaign-scoped Funky/public-debate preferences for the same user in one database transaction. This should not disable non-campaign newsletters or non-campaign alerts.

Both cascades must be atomic: after a successful write, there must not be a state where the parent/global preference is disabled but child preferences in its scope remain active.

Also implement the manual opt-in model:

3. When a user manually enables any positive notification preference, re-enable the platform/system global notification state for that user so the new preference is deliverable.

4. When a user manually enables a campaign-scoped preference, re-enable both the platform/system global notification state and the relevant campaign global preference. For the current Funky campaign, enabling `funky:notification:entity_updates` should also enable or create `funky:notification:global`.

Manual opt-in must not restore every child preference. It should only enable the notification the user explicitly selected and the parent/global preferences required to allow that notification.

## Required Behavior

### Shared Rules

1. Preserve the existing ownership check in `updateNotification()`.
2. Preserve config validation and hash recalculation behavior.
3. Do not mass re-enable child notification preferences when a global preference is set back to `true`. Re-enabling a parent/global preference should update only that parent row unless product requirements explicitly add a restore model. Without remembering previous per-preference state, mass re-enable overwrites user-specific opt-outs.
4. Do not update rows for other users.
5. Do not mutate config or hash for cascaded child rows.
6. Use explicit boolean checks such as `input.isActive === false`.
7. Distinguish manual user writes from automatic subscription creation. Automatic flows such as `ensurePublicDebateAutoSubscriptions()` must not silently undo `global_unsubscribe` unless they are handling an explicit user opt-in request.

### System Global Unsubscribe Cascade

1. The system global unsubscribe is `global_unsubscribe`.
2. It is system-managed and should remain rejected from normal `subscribe()` creation.
3. `unsubscribeViaToken()` should continue to call `notificationsRepo.deactivateGlobalUnsubscribe(userId)`.
4. `deactivateGlobalUnsubscribe(userId)` must perform the upsert and cascade in a single transaction:
   - create or update the `global_unsubscribe` row with email disabled
   - set `is_active = false` and `updated_at = updatedAt` for all other notification rows for that `user_id`
   - include campaign global rows such as `funky:notification:global`
   - include campaign entity rows such as `funky:notification:entity_updates`
   - include newsletters and alert preferences
5. The cascade should not alter the `global_unsubscribe` row after the upsert beyond the intended system-global state.
6. If the repository keeps the current meaning where `global_unsubscribe.is_active = false` means globally unsubscribed, preserve that behavior and document it in the port comment. The existing delivery code treats `is_active = false` or `config.channels.email === false` as globally unsubscribed.

Suggested transaction shape:

```ts
await this.db.transaction().execute(async (trx) => {
  await sql`
    INSERT INTO notifications (...)
    VALUES (...)
    ON CONFLICT (user_id, notification_type)
    WHERE notification_type = 'global_unsubscribe'
    DO UPDATE
    SET is_active = FALSE,
        config = EXCLUDED.config,
        hash = EXCLUDED.hash,
        updated_at = EXCLUDED.updated_at
  `.execute(trx);

  await trx
    .updateTable('notifications')
    .set({
      is_active: false,
      updated_at: updatedAt,
    } as never)
    .where('user_id', '=', userId)
    .where('notification_type', '!=', 'global_unsubscribe')
    .where('is_active', '=', true)
    .execute();
});
```

### Campaign Global Cascade

1. Trigger this cascade only when:
   - the notification being updated is `funky:notification:global`
   - `updates.isActive === false`
2. In the repository transaction:
   - update the campaign global row
   - use the updated global row's `user_id`
   - set `is_active = false` and `updated_at = updatedAt` for campaign-scoped child preferences for that user
3. At minimum, campaign-scoped child preferences include:
   - `funky:notification:entity_updates`
4. Prefer deriving campaign-scoped child types from `NOTIFICATION_TYPE_CONFIGS` where `campaignKey === PUBLIC_DEBATE_CAMPAIGN_KEY`, excluding the campaign global type itself, if that is clean in this module. Otherwise keep an explicit local list and name it clearly.
5. Do not disable:
   - `global_unsubscribe`
   - non-campaign newsletters such as `newsletter_entity_monthly`
   - non-campaign alerts such as `alert_series_analytics` and `alert_series_static`

### Manual Opt-In Parent Re-Enable

1. A manual opt-in means the user intentionally enables or subscribes to a positive notification preference through the public notification preference API, for example:
   - `PATCH /api/v1/notifications/:id` or `PUT /api/v1/notifications/:id` with `{ "isActive": true }`
   - `POST /api/v1/notifications` creating or reactivating a notification preference
2. Manual opt-in must re-enable the platform/system global state for that user:
   - if a `global_unsubscribe` row exists, update it so delivery code no longer treats the user as globally unsubscribed
   - use the existing delivery semantics in `ExtendedNotificationsRepo`: `global_unsubscribe.is_active = false` or `config.channels.email === false` means unsubscribed
   - therefore, the enabled state should make `is_active = true` and `config.channels.email = true`, with hash updated consistently
   - if no `global_unsubscribe` row exists, either no-op or create an enabled row; choose the option that best matches existing repository constraints, but document the choice
3. Manual opt-in for a campaign-scoped child preference must also re-enable that campaign's global preference:
   - for `funky:notification:entity_updates`, ensure the user's `funky:notification:global` row exists and is active
   - if the row exists inactive, set `is_active = true`
   - if the row is missing, create it with `entity_cui = null`, `config = null`, and a correct hash
4. Manual opt-in for the campaign global itself must re-enable the platform/system global state, but must not re-enable all campaign child preferences.
5. Manual opt-in for non-campaign preferences such as newsletters and alerts must re-enable only the platform/system global state, not campaign global preferences.
6. Do not implement this by changing generic repository `create()` or `update()` behavior for every caller, because some creates/updates are automatic. Prefer an explicit manual path in the use cases or repository ports so automatic flows preserve global unsubscribe.
7. Keep the target preference update and required parent re-enable updates in one transaction where practical. At minimum, do not re-enable parent globals before the target preference write has succeeded.

Suggested helper shape:

```ts
interface ManualOptInContext {
  userId: string;
  notificationType: NotificationType;
}

// Repository-level helper used only by manual preference APIs.
// It should enable global_unsubscribe for all positive manual opt-ins.
// It should additionally enable/create the campaign global for campaign child types.
applyManualNotificationOptIn(input: ManualOptInContext): Promise<Result<void, NotificationError>>;
```

If adding a separate helper would make the target preference update and parent updates non-atomic, prefer a repository method that updates/reactivates/creates the target preference and applies parent opt-in behavior in one transaction.

## Relevant Current Code

- `src/modules/notifications/core/usecases/update-notification.ts`
  - Lines around the `FUNKY_NOTIFICATION_GLOBAL_TYPE` branch call `updateCampaignGlobalPreference()` for any `isActive` update.
  - Any manual `updates.isActive === true` path should apply the manual opt-in parent re-enable rules after ownership and validation pass.
- `src/modules/notifications/core/usecases/subscribe.ts`
  - This is the manual `POST /api/v1/notifications` path.
  - Creating a new positive preference, reactivating an inactive preference, or returning an already-active preference for an explicit subscribe request should apply the manual opt-in parent re-enable rules.
- `src/modules/notifications/shell/repo/notifications-repo.ts`
  - `updateCampaignGlobalPreference()` already uses `this.db.transaction().execute(...)`.
  - The current cascade has:

```ts
.where('user_id', '=', updatedGlobal.user_id)
.where('notification_type', '=', FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE)
```

Keep this cascade campaign-scoped, but only run it for `input.isActive === false`. Do not cascade on enable.

Suggested shape:

```ts
if (input.isActive === false) {
  await trx
    .updateTable('notifications')
    .set({
      is_active: false,
      updated_at: updatedAt,
    } as never)
    .where('user_id', '=', updatedGlobal.user_id)
    .where('id', '!=', updatedGlobal.id)
    .where('notification_type', 'in', PUBLIC_DEBATE_CHILD_NOTIFICATION_TYPES)
    .where('is_active', '=', true)
    .execute();
}
```

- `src/modules/notifications/shell/repo/notifications-repo.ts`
  - `deactivateGlobalUnsubscribe()` currently performs the `global_unsubscribe` upsert.
  - Wrap the upsert and user-wide preference disable in one transaction.
  - Add the manual opt-in parent re-enable behavior here or in focused repository methods used by manual use cases.

Adjust naming/comments where needed. For example, keep `updateCampaignGlobalPreference()` campaign-scoped and update its port comment so it no longer claims to cascade the same active state on enable.

## Tests To Update

Update tests that currently encode the narrow campaign-only cascade or only test the `global_unsubscribe` row in isolation:

- `tests/unit/notifications/update-notification.test.ts`
  - Change the existing campaign global disable test so campaign entity preferences for the same user are disabled.
  - Assert newsletters and non-campaign alerts for the same user remain active.
  - Add a preference for another user and assert it remains active.
  - Add or update a test showing that enabling the campaign global preference does not re-enable campaign entity preferences.
  - Add tests showing manual enabling of any notification re-enables `global_unsubscribe`.
  - Add a test showing manual enabling of `funky:notification:entity_updates` re-enables or creates `funky:notification:global`.
  - Add a test showing manual enabling of a newsletter does not enable `funky:notification:global`.
  - Update the fake repository in `tests/fixtures/fakes.ts` so it matches the real repository behavior.

- `tests/unit/notifications/subscribe.test.ts`
  - Add tests showing manual subscribe/reactivation re-enables `global_unsubscribe`.
  - Add tests showing subscribing to `funky:notification:entity_updates` re-enables or creates `funky:notification:global`.
  - Add a test showing an explicit subscribe call for an already-active preference still re-enables `global_unsubscribe` if the user was globally unsubscribed.

- `tests/e2e/notifications-repo.test.ts`
  - Change the campaign global transaction test so disabling the campaign global row disables campaign child preferences only.
  - Assert same-user newsletters and non-campaign alerts are not affected by the campaign global cascade.
  - Assert unrelated users are not affected.
  - Assert enabling the campaign global row does not reactivate previously disabled campaign preferences.
  - Add or update a `deactivateGlobalUnsubscribe()` test so system global unsubscribe disables all same-user notification preferences, including `funky:notification:global`.
  - Add repository coverage for the manual opt-in helper/method, including:
    - newsletter opt-in clears system global unsubscribe only
    - campaign child opt-in clears system global unsubscribe and enables/creates campaign global
    - campaign global opt-in clears system global unsubscribe but does not enable campaign children
  - Assert unrelated users are not affected.

- `tests/integration/notifications-rest.test.ts`
  - Update the REST test named around public debate master toggle behavior. It should assert same-user campaign preferences are disabled after `PATCH /api/v1/notifications/:id` with `{ "isActive": false }`.
  - Assert same-user non-campaign preferences remain active.
  - If there is coverage for token unsubscribe, add or update a test showing token unsubscribe disables the user's campaign global and other preferences.
  - Add or update REST coverage showing that manually enabling a notification after token/global unsubscribe re-enables the system global state.
  - Add REST coverage showing that manually enabling a campaign child notification also re-enables the campaign global.

- `tests/unit/notifications/unsubscribe-via-token.test.ts`
  - If the fake repository exposes the cascade, assert `unsubscribeViaToken()` causes the repository to apply the system global cascade.
  - Keep token invalid and token enumeration behavior unchanged.

Search for tests that mention:

```sh
rg -n "deactivateGlobalUnsubscribe|global_unsubscribe|updateCampaignGlobalPreference|campaign master|public debate master|re-enables all public debate|cascades public debate" tests src
```

Update expectations only where they describe this cascade. Do not weaken unrelated notification delivery tests.

Also search for manual subscribe/reactivation paths:

```sh
rg -n "subscribe\\(|updates\\.isActive|isActive: true|findByUserTypeAndEntity" src/modules/notifications tests/unit/notifications tests/integration/notifications-rest.test.ts
```

## Cache Invalidation

`notifications-repo.ts` currently invalidates subscription stats based on the updated global notification type.

For system global unsubscribe, this can affect every campaign and notification type. Prefer invalidating all campaign subscription stats after the user-wide disable cascade.

For campaign global disable, invalidate the affected campaign's stats.

For manual opt-in, invalidate the affected global/campaign subscription stats if the operation changes parent/global rows.

Keep cache invalidation failures non-fatal, following the existing private invalidation helper pattern.

## Constraints

- Follow `AGENTS.md`.
- Do not read `.env` files.
- Keep core logic pure: no I/O in `core/`, return `Result<T, E>` from core use cases.
- Use TypeScript path aliases where appropriate.
- Use explicit boolean checks such as `input.isActive === false`.
- Keep changes scoped to the notifications module, fakes, and tests.
- Do not introduce raw `JSON.parse`.

## Verification

Run focused tests first:

```sh
pnpm vitest run tests/unit/notifications/update-notification.test.ts
pnpm vitest run tests/unit/notifications/subscribe.test.ts
pnpm vitest run tests/integration/notifications-rest.test.ts
pnpm vitest run tests/e2e/notifications-repo.test.ts
```

Then run:

```sh
pnpm typecheck
pnpm lint
```

If Docker-backed e2e tests are skipped locally, state that clearly and rely on the unit/integration coverage plus CI.

## Deliverable

Implement the change and report:

- files changed
- behavior before and after
- tests run and their result
- confirmation that system global unsubscribe disables campaign globals
- confirmation that campaign global disable does not disable non-campaign preferences
- confirmation that manual opt-in re-enables system global state
- confirmation that campaign child opt-in re-enables the campaign global without restoring unrelated campaign children
