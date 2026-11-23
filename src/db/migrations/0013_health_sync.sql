-- 0013_health_sync: steps sent straight from the iPhone's Health app by an Apple Shortcut, as well as screenshots.
-- Each person has one personal sync key (only its SHA-256 is stored; the key is shown once). A synced count is one
-- number per person per day, replaced by each newer sync. An admin can doubt a synced number: it then no longer
-- counts and the person is asked for a screenshot.

CREATE TABLE sync_keys (
  key_id       bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(user_id),
  key_hash     text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  hint         text NOT NULL CHECK (length(hint) <= 12),     -- last characters, to recognise it
  created_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX sync_keys_one_live ON sync_keys (user_id) WHERE revoked_at IS NULL;

CREATE TABLE health_syncs (
  sync_id        bigserial PRIMARY KEY,
  challenge_id   bigint NOT NULL REFERENCES challenges(challenge_id),
  participant_id bigint NOT NULL REFERENCES participants(participant_id),
  day            date NOT NULL,
  steps          int NOT NULL CHECK (steps BETWEEN 0 AND 200000),
  source         text NOT NULL CHECK (source IN ('APPLE_HEALTH')),
  device         text CHECK (length(device) <= 300),
  first_synced_at timestamptz NOT NULL,
  synced_at      timestamptz NOT NULL,
  times          int NOT NULL DEFAULT 1,
  doubted_at     timestamptz,
  doubted_by     bigint REFERENCES users(user_id),
  doubt_reason   text CHECK (length(doubt_reason) <= 300),
  UNIQUE (participant_id, day)
);
