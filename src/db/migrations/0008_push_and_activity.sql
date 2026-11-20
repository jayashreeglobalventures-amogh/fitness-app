-- 0008_push_and_activity: phone (Web Push) notifications with a per-person on/off switch, and what the Super Admin's
-- activity log needs: the device on each audit row, indexes for searching, and a log of server errors.

-- Audit rows also record the device (browser user agent) the action came from. Adding a nullable column is a
-- metadata change; existing rows are untouched (the append-only triggers stay as they are).
ALTER TABLE audit_log ADD COLUMN device text;
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_actor ON audit_log (actor_user_id, at DESC);
CREATE INDEX audit_log_action ON audit_log (action, at DESC);

-- Unexpected server errors (500s) and failed background work, for "something went wrong" investigations.
CREATE TABLE error_log (
  error_id   bigserial PRIMARY KEY,
  at         timestamptz NOT NULL,
  source     text NOT NULL CHECK (source IN ('REQUEST', 'BACKGROUND')),
  user_id    bigint REFERENCES users(user_id),
  method     text,
  path       text,
  message    text NOT NULL,
  stack      text,
  ip         inet,
  device     text
);
CREATE INDEX error_log_at ON error_log (at DESC);

-- Per person: phone notifications on or off (off until they switch it on).
CREATE TABLE notification_prefs (
  user_id      bigint PRIMARY KEY REFERENCES users(user_id),
  push_enabled boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL
);

-- One row per phone/browser that agreed to receive notifications.
CREATE TABLE push_subscriptions (
  subscription_id bigserial PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(user_id),
  endpoint        text NOT NULL UNIQUE CHECK (endpoint ~ '^https://'),
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  device          text,
  created_at      timestamptz NOT NULL,
  last_success_at timestamptz,
  failures        int NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- Which alerts have already been sent to a person's phone (by the alert's seen-key), so each is sent once.
CREATE TABLE push_sent (
  user_id  bigint NOT NULL REFERENCES users(user_id),
  push_key text NOT NULL,
  sent_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, push_key)
);

-- Server-generated keys (the Web Push "VAPID" key pair) when not supplied through the environment.
CREATE TABLE server_keys (
  name       text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL
);
