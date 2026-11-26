-- 0014_certificates: participation certificates, given by an admin once a challenge has ended (owner, 26 Nov 2026).
-- One row per participant who was given one; the PDF itself is drawn from the results each time it is downloaded.
CREATE TABLE certificates (
  participant_id bigint PRIMARY KEY REFERENCES participants(participant_id),
  challenge_id   bigint NOT NULL REFERENCES challenges(challenge_id),
  issued_at      timestamptz NOT NULL,
  issued_by      bigint NOT NULL REFERENCES users(user_id)
);
CREATE INDEX certificates_challenge ON certificates (challenge_id);
