-- 0007_community: a feed per challenge - announcements, posts (optional photo), achievement shares, comments with one
-- level of replies, reactions, reports, moderation and posting restrictions. Nothing is hard-deleted: deleting or
-- removing hides the item (with who/why for removals).
CREATE TABLE posts (
  post_id        bigserial PRIMARY KEY,
  challenge_id   bigint NOT NULL REFERENCES challenges(challenge_id),
  author_user_id bigint NOT NULL REFERENCES users(user_id),
  kind           text NOT NULL CHECK (kind IN ('ANNOUNCEMENT', 'POST', 'ACHIEVEMENT')),
  body           text NOT NULL CHECK (length(body) <= 2000),
  photo_file_id  bigint REFERENCES files(file_id),
  achievement    jsonb,                 -- for ACHIEVEMENT: the scoring event shared (rule, day, streak ...), never health data
  status         text NOT NULL DEFAULT 'VISIBLE' CHECK (status IN ('VISIBLE', 'DELETED', 'REMOVED')),
  pinned_at      timestamptz,
  pinned_by      bigint REFERENCES users(user_id),
  removed_by     bigint REFERENCES users(user_id),
  removed_reason text,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  CHECK (length(body) > 0 OR photo_file_id IS NOT NULL)
);
CREATE INDEX posts_feed ON posts (challenge_id, post_id DESC) WHERE status = 'VISIBLE';

CREATE TABLE comments (
  comment_id        bigserial PRIMARY KEY,
  post_id           bigint NOT NULL REFERENCES posts(post_id),
  parent_comment_id bigint REFERENCES comments(comment_id),
  author_user_id    bigint NOT NULL REFERENCES users(user_id),
  body              text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  status            text NOT NULL DEFAULT 'VISIBLE' CHECK (status IN ('VISIBLE', 'DELETED', 'REMOVED')),
  removed_by        bigint REFERENCES users(user_id),
  removed_reason    text,
  created_at        timestamptz NOT NULL
);
CREATE INDEX comments_post ON comments (post_id, comment_id);

CREATE TABLE reactions (
  post_id    bigint NOT NULL REFERENCES posts(post_id),
  user_id    bigint NOT NULL REFERENCES users(user_id),
  emoji      text NOT NULL CHECK (emoji IN ('👍', '❤️', '🔥', '👏', '💪')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (post_id, user_id, emoji)
);

CREATE TABLE community_reports (
  report_id        bigserial PRIMARY KEY,
  challenge_id     bigint NOT NULL REFERENCES challenges(challenge_id),
  post_id          bigint REFERENCES posts(post_id),
  comment_id       bigint REFERENCES comments(comment_id),
  reporter_user_id bigint NOT NULL REFERENCES users(user_id),
  reason           text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DISMISSED', 'ACTIONED')),
  decided_by       bigint REFERENCES users(user_id),
  decided_at       timestamptz,
  decision_note    text,
  created_at       timestamptz NOT NULL,
  CHECK ((post_id IS NULL) <> (comment_id IS NULL))
);
CREATE UNIQUE INDEX community_reports_once ON community_reports (reporter_user_id, coalesce(post_id, 0), coalesce(comment_id, 0)) WHERE status = 'OPEN';

-- Posting restrictions: a muted person can read and react, but not post or comment, until the given time.
CREATE TABLE community_mutes (
  challenge_id bigint NOT NULL REFERENCES challenges(challenge_id),
  user_id      bigint NOT NULL REFERENCES users(user_id),
  until        timestamptz NOT NULL,
  reason       text NOT NULL,
  muted_by     bigint NOT NULL REFERENCES users(user_id),
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (challenge_id, user_id)
);

ALTER TABLE files DROP CONSTRAINT files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check
  CHECK (purpose IN ('STEP_EVIDENCE', 'EXEMPTION_EVIDENCE', 'BONUS_EVIDENCE', 'PAYMENT_PROOF', 'PAYMENT_QR', 'PROFILE_PHOTO', 'COMMUNITY_PHOTO'));
