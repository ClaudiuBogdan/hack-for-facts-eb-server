import { Generated, ColumnType, JSONColumnType } from 'kysely';

// Helper for timestamps which can be strings or Dates depending on driver config
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

// Short Links Table
export interface ShortLinks {
  id: Generated<string>; // BIGSERIAL -> string
  code: string;
  user_ids: string[];
  original_url: string;
  created_at: Generated<Timestamp>;
  access_count: Generated<number>;
  last_access_at: Timestamp | null;
  metadata: JSONColumnType<Record<string, unknown>> | null;
}

// Notifications Table
export interface Notifications {
  id: string; // UUID
  user_id: string;
  entity_cui: string | null;
  notification_type: string;
  is_active: Generated<boolean>;
  config: JSONColumnType<Record<string, unknown>> | null;
  hash: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

// Notification Deliveries Table
export interface NotificationDeliveries {
  id: Generated<string>; // BIGSERIAL -> string
  user_id: string;
  notification_id: string; // UUID
  period_key: string;
  delivery_key: string;
  email_batch_id: string; // UUID
  sent_at: Generated<Timestamp>;
  metadata: JSONColumnType<Record<string, unknown>> | null;
  created_at: Generated<Timestamp>;
}

// Unsubscribe Tokens Table
export interface UnsubscribeTokens {
  token: string;
  user_id: string;
  notification_id: string; // UUID
  created_at: Generated<Timestamp>;
  expires_at: Generated<Timestamp>;
  used_at: Timestamp | null;
}

// Database Schema Interface
export interface UserDatabase {
  ShortLinks: ShortLinks;
  Notifications: Notifications;
  NotificationDeliveries: NotificationDeliveries;
  UnsubscribeTokens: UnsubscribeTokens;
}
