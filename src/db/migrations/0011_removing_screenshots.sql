-- 0011_removing_screenshots: people remove their own screenshot until that day's midnight; afterwards they ask an
-- admin. A removed screenshot is WITHDRAWN (kept, hidden; the day is worked out without it). An admin can erase the
-- image itself (e.g. a private photo uploaded by mistake): the file is deleted, the record stays ("image erased").
ALTER TABLE submissions ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE submissions ADD COLUMN withdrawn_by bigint REFERENCES users(user_id);
ALTER TABLE submissions ADD COLUMN withdraw_reason text CHECK (length(withdraw_reason) <= 500);

ALTER TABLE submissions DROP CONSTRAINT submissions_status_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check
  CHECK (status IN ('PENDING_AI', 'PENDING_REVIEW', 'ACHIEVED', 'BELOW_TARGET', 'REJECTED', 'SUPERSEDED', 'APPROVED', 'WITHDRAWN'));
ALTER TABLE submissions DROP CONSTRAINT submissions_part_status;
ALTER TABLE submissions ADD CONSTRAINT submissions_part_status
  CHECK (CASE WHEN part THEN status IN ('PENDING_AI', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN') ELSE status <> 'APPROVED' END);
ALTER TABLE submissions ADD CONSTRAINT submissions_withdrawn CHECK ((status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL));

-- A removed single screenshot no longer blocks a new upload for that day.
DROP INDEX submissions_one_live;
CREATE UNIQUE INDEX submissions_one_live ON submissions (participant_id, day) WHERE status NOT IN ('SUPERSEDED', 'WITHDRAWN') AND NOT part;

ALTER TABLE files ADD COLUMN erased_at timestamptz;
ALTER TABLE files ADD COLUMN erased_by bigint REFERENCES users(user_id);

-- Requests to an admin: REMOVE a screenshot after its day is over, and/or ERASE its image.
CREATE TABLE evidence_requests (
  request_id      bigserial PRIMARY KEY,
  challenge_id    bigint NOT NULL REFERENCES challenges(challenge_id),
  submission_id   bigint NOT NULL REFERENCES submissions(submission_id),
  participant_id  bigint NOT NULL REFERENCES participants(participant_id),
  kind            text NOT NULL CHECK (kind IN ('REMOVE', 'ERASE')),
  erase_image     boolean NOT NULL DEFAULT false,   -- REMOVE: also asked to erase the image
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED')),
  requested_at    timestamptz NOT NULL,
  decided_by      bigint REFERENCES users(user_id),
  decided_at      timestamptz,
  decision_note   text CHECK (length(decision_note) <= 500)
);
CREATE UNIQUE INDEX evidence_requests_one_pending ON evidence_requests (submission_id) WHERE status = 'PENDING';
CREATE INDEX evidence_requests_queue ON evidence_requests (challenge_id, status);
