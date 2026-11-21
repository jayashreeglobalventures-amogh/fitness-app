-- 0010_multiple_screenshots: a challenge may allow several screenshots a day (Settings -> Evidence). Each is then a
-- "part" with its own reading; parts are APPROVED (their value counts) or REJECTED, and the day is decided from the
-- approved parts (added up, or the highest). Days with a single screenshot work exactly as before.
ALTER TABLE submissions ADD COLUMN part boolean NOT NULL DEFAULT false;

ALTER TABLE submissions DROP CONSTRAINT submissions_status_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check
  CHECK (status IN ('PENDING_AI', 'PENDING_REVIEW', 'ACHIEVED', 'BELOW_TARGET', 'REJECTED', 'SUPERSEDED', 'APPROVED'));
-- Parts are only APPROVED/REJECTED/pending; single screenshots never APPROVED.
ALTER TABLE submissions ADD CONSTRAINT submissions_part_status
  CHECK (CASE WHEN part THEN status IN ('PENDING_AI', 'PENDING_REVIEW', 'APPROVED', 'REJECTED') ELSE status <> 'APPROVED' END);

-- Still at most one live single screenshot per day; parts are not limited by this (the app caps them).
DROP INDEX submissions_one_live;
CREATE UNIQUE INDEX submissions_one_live ON submissions (participant_id, day) WHERE status <> 'SUPERSEDED' AND NOT part;
CREATE INDEX submissions_parts ON submissions (participant_id, day) WHERE part;

-- An admin's "approve" of one of several screenshots is recorded in the review history like any other decision.
ALTER TABLE verification_results DROP CONSTRAINT verification_results_outcome_check;
ALTER TABLE verification_results ADD CONSTRAINT verification_results_outcome_check
  CHECK (outcome IN ('AUTO_APPROVED', 'NEEDS_REVIEW', 'ERROR', 'ACHIEVED', 'BELOW_TARGET', 'REJECTED', 'APPEALED', 'APPROVED'));
