# Notifications

We need a way to generate different notifications based on different needs.

- Initial user registration
- User notification subscription confirmation?
- Monthly notifications with the executie bugetara data and alerts.
- Challenge notifications based on system challenge review, different challenge phases, entity public debate. (do we send calendar over email?)

The question is:

- How do we generate those notifications (cron, event based, api calls?)
- How do we make sure we don't duplicate notifications?
- How do we manage generating the email templates?
- How do we manage sending the notifications?
- How do we manage notifications preferences?

## User registration

- We need to setup the webhook to receive the user registration event from the platform.
- After we receive the webhook, we can queue the notification delivery for the user.
- Before sending the notification, we check the db for the unique notification key and prevent duplicate notifications.
- We use the welcome template and send the notification using resend, then add the notification key to the db.

## User notification subscription confirmation

- When the user subscribe for the first time to an entity or alert, we send a confirmation email to the user.
- We need a dedicated template for it, maybe also include some tips and tricks and set expectation about the notification system, frequency, etc.
- This should be an one of per user, similar to registration notification.

## Monthly notifications

- For this one, it's a bit more complex. We need a way to trigger the notification after uploading the data. The trigger should be protected and only accessible to the platform administrators.
- The key is the user id, notification type and date. the date is probably YYYY-MM, or YYYY-QQ, or YYYY, depending on the type of notification.
- Here, the complexity is also deciding the format of the email template, as we have a lot of data and we need to present it in a simple and graphical way. We could use a dedicated client with dynamic image generation and embed the image in the email.
- We need to consider batching the email sending, as we have a lot of users subscribed to the notifications.

## Challenge notifications

- When to trigger:
  - When the user accept the terms and conditions of the campaign.
  - When the user sends a request for the campaign.
  - When the system review the interactive elements.
  - When deadline for public debate request is approaching.
  - When new local budget calendar events is reached.
  - Weekly updates with progress and tips and tricks.
- How to trigger:
  - When new user interaction event is sent related to terms and conditions. Verify the event and create the notification.
  - Same for the campaign. We sent the email to the user based on the interactive element.
  - For system reviewed element, we may need to batch them per user. We will probably run it as an admin endpoint.
  - For deadline and phases, we will probably run a cronjob to check each use entity.
  - For weekly updates, we will probably run a cronjob to send the email to the users.

## Notification preferences

Use the notifications table with static keys and json payload to store the preferences.

- Global notifications
- Campaign notifications

## Notification flow

1. Trigger the notification generation (event, cron, etc). Each module has its own strategy to generate the notification based on different requirements.
2. We need to check if the user has subscribed to the notification. Depends on each module/notification type.
3. We generate:
   - Unique notification key.
   - User id, notification type, template id. Avoid adding payload into the queue for security reasons. The queue is untrusted.
   - Maybe a send at to schedule the notification?
4. Add the notification to the bullmq queue.
5. Process notification queue: (We need to think about the bulk strategy. (max 100 notifications per batch))
   1. We double check that the notification wasn't sent already. We use the db unique key.
   2. We double check the preferences.
   3. We send the notification.
   4. We update the notification status to sent. (we need to check this, as the email can be rejected. Should we relay on the resend webhook to update the status?)

We need a strategy for handling failures.
We need a strategy for handling templates. (payload validation, etc.)
We need a strategy for handling preferences.
We need a strategy for handling unsubscribe requests.

## Institution emails

The high level design of the institution email:

- We store an institution correspondence thread as a row in the institution correspondence table.
- There are two triggers for starting a thread:
  - We send a request to the institution to start a public debate.
  - A third party association send the email and uses our system email as cc.
- After the thread is started, we need to capture followups and add to the thread.
- We want to be able to use an ai agent to process the institution response and create a followup email for the institution or just update the state. We should have an admin api for that.
- We need to notify the users on each phase of the thread. We should have a list of subscribed users to that institution. We also need to add a notification preference for the user for this campaign, to allow disable notifications.
- It is importat that we don't send multiple emails from our system for the same institution. If the request was already made, we just subscribe the users to the institution queue, maybe inform the user using email.

## User campaign notifications

- We need a notification preference to store the user notification enable/disable for the campaign.
- We want to send email notifications to the user for different triggers tbd.
  - The welcome email with info about the campaign.
  - When a new calendar phase is reached.
  - When the institution debate request changes state.
  - Other events. We need to review the interactive elements.

## User notification preferences
