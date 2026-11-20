-- 0002_scoring: the points ledger and weekend bonus activities.
-- Points are never stored as an editable total. Each award or penalty is an append-only row with a unique
-- idempotency key; a correction is a REVERSAL row (and, if needed, a new award) - nothing is updated or deleted.
-- The engine recomputes what the events SHOULD be from the facts (day statuses, roster, rules in force on each day)
-- and appends only the difference, so running it twice changes nothing.

CREATE TABLE scoring_events (
  event_id        bigserial PRIMARY KEY,
  challenge_id    bigint NOT NULL REFERENCES challenges(challenge_id),
  participant_id  bigint REFERENCES participants(participant_id),   -- null for team-level records (streak breaks)
  -- What this is about, stable across recomputations, e.g. 'daily:12:2026-11-22', 'pstreak:12:2026-11-22:7'.
  base_key        text NOT NULL,
  -- Unique per row: base_key + '#' + sequence; makes every insert idempotent.
  idem_key        text NOT NULL UNIQUE,
  rule            text NOT NULL CHECK (rule IN ('DAILY_SUCCESS', 'PERSONAL_STREAK', 'TEAM_STREAK', 'COMEBACK', 'WEEKEND_BONUS',
                                                'MISSED_DAY', 'CONSECUTIVE_MISSES', 'TEAM_STREAK_BREAK', 'TEAM_STREAK_BROKEN')),
  kind            text NOT NULL CHECK (kind IN ('AWARD', 'REVERSAL')),
  reverses_event_id bigint REFERENCES scoring_events(event_id),
  day             date NOT NULL,
  points          int NOT NULL,
  rules_version_no int NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL,
  CHECK ((kind = 'REVERSAL') = (reverses_event_id IS NOT NULL))
);
CREATE INDEX scoring_events_participant ON scoring_events (participant_id, day);
CREATE INDEX scoring_events_base ON scoring_events (challenge_id, base_key);
CREATE TRIGGER scoring_events_append_only BEFORE UPDATE OR DELETE ON scoring_events FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER scoring_events_no_truncate BEFORE TRUNCATE ON scoring_events FOR EACH STATEMENT EXECUTE FUNCTION refuse_change();

-- An optional weekend activity set up by an admin (any format: cycling, swim, hike, gym, extra walk ...).
CREATE TABLE bonus_activities (
  activity_id   bigserial PRIMARY KEY,
  challenge_id  bigint NOT NULL REFERENCES challenges(challenge_id),
  weekend_key   date NOT NULL,          -- the weekend's first day (rules: scoring.weekendBonus.weekend)
  title         text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  description   text NOT NULL CHECK (length(description) <= 2000),
  evidence      text NOT NULL CHECK (length(evidence) <= 500),   -- what to upload / show
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CANCELLED')),
  created_by    bigint NOT NULL REFERENCES users(user_id),
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX bonus_activities_challenge ON bonus_activities (challenge_id, weekend_key);

CREATE TABLE bonus_submissions (
  bonus_submission_id bigserial PRIMARY KEY,
  activity_id    bigint NOT NULL REFERENCES bonus_activities(activity_id),
  participant_id bigint NOT NULL REFERENCES participants(participant_id),
  file_id        bigint REFERENCES files(file_id),
  note           text CHECK (length(note) <= 1000),
  status         text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  received_at    timestamptz NOT NULL,
  decided_by     bigint REFERENCES users(user_id),
  decided_at     timestamptz,
  decision_reason text,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);
CREATE UNIQUE INDEX bonus_submissions_one_live ON bonus_submissions (activity_id, participant_id) WHERE status IN ('PENDING', 'APPROVED');

ALTER TABLE files DROP CONSTRAINT files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check CHECK (purpose IN ('STEP_EVIDENCE', 'EXEMPTION_EVIDENCE', 'BONUS_EVIDENCE'));
