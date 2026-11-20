-- 0001_daily_participation: evidence files, daily submissions and their verification, rest days, exemptions + votes.
-- The participant-day status (achieved / missed / rest / excused ...) is DERIVED from these rows (src/modules/checkin),
-- never stored as an editable total. Decisions are rows with who/when/why; nothing is deleted.

-- Uploaded files: bytes on the media volume (content-addressed), metadata and ownership here.
CREATE TABLE files (
  file_id       bigserial PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES users(user_id),
  purpose       text NOT NULL CHECK (purpose IN ('STEP_EVIDENCE', 'EXEMPTION_EVIDENCE')),
  storage_key   text NOT NULL,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type     text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes         int NOT NULL CHECK (bytes > 0),
  uploaded_by   bigint NOT NULL REFERENCES users(user_id),
  created_at    timestamptz NOT NULL
);
CREATE INDEX files_sha ON files (sha256);

-- One row per piece of daily evidence. A resubmission supersedes the previous one (kept, status SUPERSEDED).
CREATE TABLE submissions (
  submission_id   bigserial PRIMARY KEY,
  challenge_id    bigint NOT NULL REFERENCES challenges(challenge_id),
  participant_id  bigint NOT NULL REFERENCES participants(participant_id),
  day             date NOT NULL,
  file_id         bigint NOT NULL REFERENCES files(file_id),
  -- When the complete upload reached the server: this, never processing time, decides the deadline.
  received_at     timestamptz NOT NULL,
  client_ref      text NOT NULL CHECK (length(client_ref) BETWEEN 8 AND 64),
  claimed_value   int CHECK (claimed_value >= 0),
  status          text NOT NULL CHECK (status IN ('PENDING_AI', 'PENDING_REVIEW', 'ACHIEVED', 'BELOW_TARGET', 'REJECTED', 'SUPERSEDED')),
  final_value     int CHECK (final_value >= 0),
  ai_attempts     int NOT NULL DEFAULT 0,
  appealed_at     timestamptz,
  appeal_note     text,
  -- ADMIN_CORRECTION: recorded by an admin for the participant (e.g. evidence sent before the app was live);
  -- received_at is then the original time, given by the admin, and recorded_by/correction_reason say who and why.
  source          text NOT NULL DEFAULT 'PARTICIPANT' CHECK (source IN ('PARTICIPANT', 'ADMIN_CORRECTION')),
  recorded_by     bigint NOT NULL REFERENCES users(user_id),
  correction_reason text,
  supersedes_id   bigint REFERENCES submissions(submission_id),
  decided_by      bigint REFERENCES users(user_id),
  decided_at      timestamptz,
  decision_reason text,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  UNIQUE (participant_id, client_ref)
);
-- At most one live (not superseded) submission per participant-day.
CREATE UNIQUE INDEX submissions_one_live ON submissions (participant_id, day) WHERE status <> 'SUPERSEDED';
CREATE INDEX submissions_queue ON submissions (challenge_id, status, received_at);

-- Every reading and every decision about a submission (AI attempts, admin reviews, overrides). Append-only.
CREATE TABLE verification_results (
  result_id       bigserial PRIMARY KEY,
  submission_id   bigint NOT NULL REFERENCES submissions(submission_id),
  method          text NOT NULL CHECK (method IN ('AI', 'ADMIN', 'SYSTEM')),
  provider        text,
  model           text,
  extracted_date  date,
  extracted_value int,
  source_app      text,
  confidence      numeric(4,3),
  readable        boolean,
  flags           jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome         text NOT NULL CHECK (outcome IN ('AUTO_APPROVED', 'NEEDS_REVIEW', 'ERROR', 'ACHIEVED', 'BELOW_TARGET', 'REJECTED', 'APPEALED')),
  reason          text,
  actor_user_id   bigint REFERENCES users(user_id),
  created_at      timestamptz NOT NULL
);
CREATE INDEX verification_results_submission ON verification_results (submission_id, result_id);
CREATE TRIGGER verification_results_append_only BEFORE UPDATE OR DELETE ON verification_results FOR EACH ROW EXECUTE FUNCTION refuse_change();

CREATE TABLE rest_days (
  rest_day_id    bigserial PRIMARY KEY,
  challenge_id   bigint NOT NULL REFERENCES challenges(challenge_id),
  participant_id bigint NOT NULL REFERENCES participants(participant_id),
  day            date NOT NULL,
  period_no      int NOT NULL,
  declared_at    timestamptz NOT NULL,
  source         text NOT NULL CHECK (source IN ('PARTICIPANT', 'ADMIN_CORRECTION')),
  declared_by    bigint NOT NULL REFERENCES users(user_id),
  reason         text,
  cancelled_at   timestamptz,
  cancelled_by   bigint REFERENCES users(user_id),
  cancel_reason  text,
  created_at     timestamptz NOT NULL
);
CREATE UNIQUE INDEX rest_days_one_live ON rest_days (participant_id, day) WHERE cancelled_at IS NULL;

CREATE TABLE exemption_requests (
  request_id      bigserial PRIMARY KEY,
  challenge_id    bigint NOT NULL REFERENCES challenges(challenge_id),
  participant_id  bigint NOT NULL REFERENCES participants(participant_id),
  start_day       date NOT NULL,
  end_day         date NOT NULL CHECK (end_day >= start_day),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  evidence_file_id bigint REFERENCES files(file_id),
  status          text NOT NULL CHECK (status IN ('VOTING', 'ADMIN_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  -- The voting rules in force when the request was made (copied, so a later rules change can't alter a live vote).
  voting          jsonb,
  voting_closes_at timestamptz,
  eligible_voters bigint[] NOT NULL DEFAULT '{}',
  review_reason   text,      -- why it went to admin review (tie, too few votes, no voting configured)
  decided_by      bigint REFERENCES users(user_id),
  decided_at      timestamptz,
  decision_reason text,
  decision_method text CHECK (decision_method IN ('VOTE', 'ADMIN', 'ADMIN_OVERRIDE')),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX exemption_requests_challenge ON exemption_requests (challenge_id, status);

CREATE TABLE exemption_votes (
  request_id           bigint NOT NULL REFERENCES exemption_requests(request_id),
  voter_participant_id bigint NOT NULL REFERENCES participants(participant_id),
  vote                 text NOT NULL CHECK (vote IN ('APPROVE', 'REJECT')),
  cast_at              timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  PRIMARY KEY (request_id, voter_participant_id)
);
