-- 0005: profile photos, and which notifications a person has already seen (for the Alerts badge).
ALTER TABLE user_profiles ADD COLUMN photo_file_id bigint REFERENCES files(file_id);

ALTER TABLE files DROP CONSTRAINT files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check
  CHECK (purpose IN ('STEP_EVIDENCE', 'EXEMPTION_EVIDENCE', 'BONUS_EVIDENCE', 'PAYMENT_PROOF', 'PAYMENT_QR', 'PROFILE_PHOTO'));

-- A notification is "seen" by its key (its id plus anything that changes its meaning, e.g. a count), so a new
-- screenshot to review makes the item new again. Kept per user (same badge on every device).
CREATE TABLE notification_seen (
  user_id    bigint NOT NULL REFERENCES users(user_id),
  seen_key   text NOT NULL CHECK (length(seen_key) <= 200),
  seen_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, seen_key)
);
