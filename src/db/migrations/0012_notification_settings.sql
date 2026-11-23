-- 0012_notification_settings: each person chooses which kinds of alerts they want (within what the challenge allows),
-- alerts that come from something happening (a screenshot decided by an admin, a payment confirmed, moving up the
-- leaderboard) are kept for a week, and a daily leaderboard snapshot tells who moved up.

-- Overrides of the default per kind, e.g. {"communityPosts": true, "weeklySummary": false}. Missing = the default.
ALTER TABLE notification_prefs ADD COLUMN prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE user_notices (
  notice_id    bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(user_id),
  challenge_id bigint REFERENCES challenges(challenge_id),
  notice_key   text NOT NULL CHECK (length(notice_key) BETWEEN 1 AND 150),  -- one alert per key per person
  category     text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('action', 'info', 'warning')),
  title        text NOT NULL CHECK (length(title) <= 200),
  body         text NOT NULL CHECK (length(body) <= 500),
  link         text NOT NULL,
  created_at   timestamptz NOT NULL,
  UNIQUE (user_id, notice_key)
);
CREATE INDEX user_notices_recent ON user_notices (user_id, created_at DESC);

-- The ranks at one moment of a day (taken once a day, in the morning), to tell people they moved up.
CREATE TABLE rank_snapshots (
  challenge_id bigint NOT NULL REFERENCES challenges(challenge_id),
  day          date NOT NULL,
  ranks        jsonb NOT NULL,          -- {"<participantId>": rank}
  taken_at     timestamptz NOT NULL,
  PRIMARY KEY (challenge_id, day)
);
