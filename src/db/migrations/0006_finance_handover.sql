-- 0006: one finance manager per challenge, changed only through a handover that the incoming manager accepts.
-- (If a challenge somehow had two, keep the earliest one.)
DELETE FROM challenge_roles r USING challenge_roles k
 WHERE r.role = 'FINANCE_ADMIN' AND k.role = 'FINANCE_ADMIN' AND r.challenge_id = k.challenge_id AND r.granted_at > k.granted_at;
CREATE UNIQUE INDEX challenge_roles_one_finance_manager ON challenge_roles (challenge_id) WHERE role = 'FINANCE_ADMIN';

CREATE TABLE finance_handovers (
  handover_id      bigserial PRIMARY KEY,
  challenge_id     bigint NOT NULL REFERENCES challenges(challenge_id),
  from_user_id     bigint REFERENCES users(user_id),         -- null when there was no finance manager
  to_user_id       bigint NOT NULL REFERENCES users(user_id),
  status           text NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'CANCELLED')),
  -- The checks the admin saw and confirmed when starting it:
  cash_held_paise  bigint NOT NULL,      -- money held (confirmed payments - payouts) to hand over
  pending_payments int NOT NULL,         -- payment reports still waiting to be checked
  pending_refunds  int NOT NULL,         -- refund proposals still waiting
  admin_note       text CHECK (length(admin_note) <= 1000),
  initiated_by     bigint NOT NULL REFERENCES users(user_id),
  initiated_at     timestamptz NOT NULL,
  -- The incoming manager's confirmation:
  received_paise   bigint,
  accept_statement text CHECK (length(accept_statement) <= 1000),
  accepted_at      timestamptz,
  cancelled_by     bigint REFERENCES users(user_id),
  cancelled_at     timestamptz,
  cancel_reason    text,
  updated_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX finance_handovers_one_pending ON finance_handovers (challenge_id) WHERE status = 'PENDING';

-- After a handover the old payment details are hidden from participants until the new manager sets theirs.
ALTER TABLE payment_settings ADD COLUMN needs_update boolean NOT NULL DEFAULT false;
