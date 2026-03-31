export type DeliveryStatus =
  | 'pending'
  | 'composing'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'webhook_timeout'
  | 'failed_transient'
  | 'failed_permanent'
  | 'suppressed'
  | 'skipped_unsubscribed'
  | 'skipped_no_email';
