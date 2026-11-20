-- 0000_foundation: identity, profiles, roles, challenges (versioned configuration), invitations, participants, audit.
-- Conventions (from AaryaShree IMS): hand-written SQL, applied in order by the Drizzle migrator, never edited once
-- applied - a change is a new numbered file. Calendar days are `date` in the challenge's time zone; instants are
-- timestamptz; money (later) is integer paise.

-- ==================== Identity ====================
CREATE TABLE users (
  user_id              bigserial PRIMARY KEY,
  username             text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,32}$'),
  display_name         text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_by           bigint REFERENCES users(user_id),
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  password_changed_at  timestamptz,
  last_login_at        timestamptz
);

-- Platform-wide roles. SUPER_ADMIN: full platform and challenge control - but NOT private health data (PRD 4).
CREATE TABLE platform_roles (
  user_id    bigint NOT NULL REFERENCES users(user_id),
  role       text NOT NULL CHECK (role IN ('SUPER_ADMIN')),
  granted_by bigint REFERENCES users(user_id),
  granted_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, role)
);

-- Session token: random 32 bytes in an HttpOnly cookie; only its SHA-256 is stored.
CREATE TABLE sessions (
  session_hash text PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(user_id),
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text,
  ip           inet
);
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_attempts (
  attempt_id bigserial PRIMARY KEY,
  username   text NOT NULL,
  ip         inet,
  success    boolean NOT NULL,
  at         timestamptz NOT NULL
);
CREATE INDEX login_attempts_lookup ON login_attempts (username, ip, at);

-- ==================== Profile ====================
-- Basic profile only. Health data (measurements, consent, field-level sharing) gets its own tables with
-- row-level security in a later migration; nothing health-related is stored here.
CREATE TABLE user_profiles (
  user_id    bigint PRIMARY KEY REFERENCES users(user_id),
  full_name  text CHECK (length(full_name) <= 120),
  mobile     text CHECK (mobile ~ '^\+?[0-9]{8,15}$'),
  email      text CHECK (length(email) <= 200),
  birth_date date,
  gender     text CHECK (length(gender) <= 40),
  location   text CHECK (length(location) <= 120),
  about      text CHECK (length(about) <= 1000),
  -- Who may see each optional field: {"mobile":"PRIVATE","location":"CHALLENGE_MEMBERS",...}. Missing = PRIVATE.
  visibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL
);

-- ==================== Challenges ====================
-- A challenge's rules live in challenge_versions.config (validated JSON, src/modules/challenges/config.ts).
-- The columns here mirror the current version for listing and are updated with it.
CREATE TABLE challenges (
  challenge_id bigserial PRIMARY KEY,
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name         text NOT NULL,
  category     text NOT NULL,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  time_zone    text NOT NULL,
  starts_on    date NOT NULL,
  ends_on      date NOT NULL CHECK (ends_on >= starts_on),
  duplicated_from bigint REFERENCES challenges(challenge_id),
  created_by   bigint NOT NULL REFERENCES users(user_id),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  published_at timestamptz,
  archived_at  timestamptz
);

-- Versioned rules. While a challenge is a DRAFT its single version is edited in place (nothing depends on it yet);
-- once PUBLISHED every change is a new version with an effective_from day, so earlier days keep their rules.
CREATE TABLE challenge_versions (
  version_id     bigserial PRIMARY KEY,
  challenge_id   bigint NOT NULL REFERENCES challenges(challenge_id),
  version_no     int NOT NULL CHECK (version_no >= 1),
  config         jsonb NOT NULL,
  effective_from date NOT NULL,
  reason         text,
  created_by     bigint NOT NULL REFERENCES users(user_id),
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  UNIQUE (challenge_id, version_no)
);

-- Per-challenge administrative roles. A user may hold several, and may also be a participant.
CREATE TABLE challenge_roles (
  challenge_id bigint NOT NULL REFERENCES challenges(challenge_id),
  user_id      bigint NOT NULL REFERENCES users(user_id),
  role         text NOT NULL CHECK (role IN ('CHALLENGE_ADMIN', 'FINANCE_ADMIN')),
  granted_by   bigint NOT NULL REFERENCES users(user_id),
  granted_at   timestamptz NOT NULL,
  PRIMARY KEY (challenge_id, user_id, role)
);

-- ==================== Roster ====================
CREATE TABLE invitations (
  invitation_id   bigserial PRIMARY KEY,
  challenge_id    bigint NOT NULL REFERENCES challenges(challenge_id),
  user_id         bigint NOT NULL REFERENCES users(user_id),
  status          text NOT NULL CHECK (status IN ('INVITED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED')),
  invited_by      bigint NOT NULL REFERENCES users(user_id),
  invited_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  -- After the roster locks (challenge start) a join needs an Admin-approved first day; null before the start.
  approved_join_on date,
  approval_reason text,
  responded_at    timestamptz,
  updated_at      timestamptz NOT NULL
);
-- At most one open invitation per person per challenge.
CREATE UNIQUE INDEX invitations_one_open ON invitations (challenge_id, user_id) WHERE status = 'INVITED';

CREATE TABLE participants (
  participant_id  bigserial PRIMARY KEY,
  challenge_id    bigint NOT NULL REFERENCES challenges(challenge_id),
  user_id         bigint NOT NULL REFERENCES users(user_id),
  invitation_id   bigint REFERENCES invitations(invitation_id),
  status          text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'WITHDRAWN', 'REMOVED', 'DISQUALIFIED', 'COMPLETED')),
  -- First and last challenge day this person takes part in (inclusive). Scoring and team days use these, never
  -- the status alone, so a withdrawal never changes the past.
  joined_on       date NOT NULL,
  left_on         date,
  rules_version_no int NOT NULL,
  fitness_rules_accepted_at   timestamptz NOT NULL,
  financial_rules_accepted_at timestamptz,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  UNIQUE (challenge_id, user_id),
  CHECK (left_on IS NULL OR left_on >= joined_on - 1)
);

CREATE TABLE participant_status_history (
  history_id     bigserial PRIMARY KEY,
  participant_id bigint NOT NULL REFERENCES participants(participant_id),
  from_status    text,
  to_status      text NOT NULL,
  effective_on   date NOT NULL,
  reason         text NOT NULL,
  financial_outcome text,
  actor_user_id  bigint NOT NULL REFERENCES users(user_id),
  at             timestamptz NOT NULL
);

-- ==================== Audit ====================
CREATE TABLE audit_log (
  audit_id      bigserial PRIMARY KEY,
  at            timestamptz NOT NULL,
  actor_user_id bigint REFERENCES users(user_id),
  challenge_id  bigint REFERENCES challenges(challenge_id),
  action        text NOT NULL,
  entity        text NOT NULL,
  entity_id     text NOT NULL,
  reason        text,
  before        jsonb,
  after         jsonb,
  ip            inet
);
CREATE INDEX audit_log_challenge ON audit_log (challenge_id, at);
CREATE INDEX audit_log_entity ON audit_log (entity, entity_id);

-- Append-only, enforced by the database for every role (corrections are new rows, never edits).
CREATE FUNCTION refuse_change() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION refuse_change();
CREATE TRIGGER status_history_append_only BEFORE UPDATE OR DELETE ON participant_status_history FOR EACH ROW EXECUTE FUNCTION refuse_change();
