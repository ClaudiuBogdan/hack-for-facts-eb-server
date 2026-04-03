# TODOs

- Don't send failed institution send email to user. Send to admin only.
- Send confirmation email when email is sent to institution.
- Database migration in prod. Backup data first.
- Add test email in dev and prod for entity flow: <test+entity:cui@transparenta.eu>
- Review gdpr strategy (session: gdpr-review)
- Review clerk cache email!
- Rate limit review: should use redis?
- We need to centralize the static ids for user interactions.
- Wee need to process clerk webhooks, specially user created/deleted.

## Notifications

- [ ] TEST: Add unsubscribe link with self signed token and return success html.
- [ ] Implement the email institution sending, with deduplication and lifecycle management. Add subscribed users to a specific institution queue.
- [ ] Add user email notification on registration? And use the hook to set the notifications preferences?
- [ ] Use a global footer for unsubscribe link.
- [ ] Remove admin endpoint from public istio gateway. Protect admin with secret and private path.
- [ ] Add the unsubscribe api link to the footer, return html for GET request or maybe check if we can use json/html based on request header.
- [ ] Public debate self-send: decide when to approve the learning-progress record and implement it. `send_yourself` submissions currently stay pending unless manually reviewed.
- [ ] Prevent duplicate platform-send threads/emails for the same entity under concurrency. Add a real idempotency guard beyond the current read-then-create flow, while still allowing retries after failed sends.
- [ ] Respect global unsubscribe in the event-driven public-debate notification enqueue path (`findActiveByTypeAndEntity`) so we do not create outbox rows and compose/send jobs for opted-out users.
- [ ] Harden public debate entity update publishing. The publisher currently logs and swallows enqueue failures, so `thread_started`, `reply_received`, and `reply_reviewed` notifications can be missed without surfacing that to the caller/admin flow.
- [ ] Improve public debate compose-worker diagnostics so invalid outbox metadata tells us which required field is missing instead of only returning `Invalid public debate update metadata`.
- [ ] Guard self-send thread creation against concurrent webhook replay races. Matching by interaction key is not protected by a uniqueness constraint yet.
- [ ] Allow `campaign_public_debate_entity_updates` through `POST /api/v1/notifications`. The client can toggle this type, but the current subscribe schema still rejects it.
- [ ] TEST: Add coverage for public debate publisher wiring and failure handling (`thread_started`, `thread_failed`, `reply_received`, `reply_reviewed`), `POST /api/v1/notifications` for `campaign_public_debate_entity_updates`, and public-debate compose failures (invalid metadata and render errors).

---

- [ ] Add production ready build process/pipeline. (main branch, golden master tests, etc.)
- [ ] Add notification email module.
- [ ] Add openapi for mcp and update custom chatgpt.
- [ ] Add date filtering to the datasets. You could use the x axis type to filter the data. You need to design a flexible but simple interface for the filter.
- [ ] We need to design a uat scoped dataset with historical data. We need to load county gdp, population, cpi, exchange rate, etc.

## Nice to have

- [ ] Design a lazy loading data loader for eurostat and insse tempo. We should probably store the data in db.
- [ ] Add graphql and rest api for all endpoints. Explore mercurius rest api plugin.
- [ ] Migrate uat and county heatmaps to use full analytics filters. We should include all the entities from the uat, not just the uat entity.
- [ ] Improve heatmap graphql format. We could add a csv string field for the data.
