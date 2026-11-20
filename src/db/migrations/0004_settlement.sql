-- 0004_settlement: final settlement (PRD 11). A settlement is a recommendation that a Super Admin approves; once
-- approved its snapshot can never change (later corrections are a new settlement that supersedes it). Approval books
-- each prize in the ledger (MAIN_POOL -> PRIZE_DUE:<p>); a recorded payout settles what the person is owed
-- (PRIZE_DUE / REFUND_DUE, minus anything they still owe) against CASH.

CREATE TABLE settlements (
  settlement_id   bigserial PRIMARY KEY,
  challenge_id    bigint NOT NULL REFERENCES challenges(challenge_id),
  version_no      int NOT NULL,
  status          text NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED')),
  snapshot        jsonb NOT NULL,               -- standings, eligibility, pools, allocations, statements, checks, tie decisions
  supersedes_id   bigint REFERENCES settlements(settlement_id),
  reason          text,                         -- why a new version (adjustment) was made
  prepared_by     bigint NOT NULL REFERENCES users(user_id),
  prepared_at     timestamptz NOT NULL,
  approved_by     bigint REFERENCES users(user_id),
  approved_at     timestamptz,
  published_at    timestamptz,
  updated_at      timestamptz NOT NULL,
  UNIQUE (challenge_id, version_no)
);
-- At most one draft, and at most one approved/published settlement, per challenge (a correction is drafted while the
-- approved one stays in force, and replaces it only when approved).
CREATE UNIQUE INDEX settlements_one_draft ON settlements (challenge_id) WHERE status = 'DRAFT';
CREATE UNIQUE INDEX settlements_one_in_force ON settlements (challenge_id) WHERE status IN ('APPROVED', 'PUBLISHED');

-- Once out of DRAFT, the snapshot is frozen.
CREATE FUNCTION settlement_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
    RAISE EXCEPTION 'settlement % is % and can no longer change', OLD.settlement_id, OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlements_frozen BEFORE UPDATE ON settlements FOR EACH ROW EXECUTE FUNCTION settlement_frozen();
CREATE TRIGGER settlements_no_delete BEFORE DELETE ON settlements FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- Money actually paid out to a participant for an approved settlement (prize + refund - what they still owe).
CREATE TABLE payouts (
  payout_id      bigserial PRIMARY KEY,
  settlement_id  bigint NOT NULL REFERENCES settlements(settlement_id),
  participant_id bigint NOT NULL REFERENCES participants(participant_id),
  prize_paise    bigint NOT NULL CHECK (prize_paise >= 0),
  refund_paise   bigint NOT NULL CHECK (refund_paise >= 0),
  setoff_paise   bigint NOT NULL CHECK (setoff_paise >= 0),   -- part of what they still owed, deducted
  paid_paise     bigint NOT NULL CHECK (paid_paise >= 0),
  method         text NOT NULL CHECK (method IN ('UPI', 'CASH', 'BANK_TRANSFER', 'OTHER', 'NONE')),
  reference      text CHECK (length(reference) <= 60),
  paid_on        date NOT NULL,
  note           text CHECK (length(note) <= 500),
  recorded_by    bigint NOT NULL REFERENCES users(user_id),
  recorded_at    timestamptz NOT NULL,
  CHECK (prize_paise + refund_paise = setoff_paise + paid_paise),
  UNIQUE (settlement_id, participant_id)
);
CREATE TRIGGER payouts_append_only BEFORE UPDATE OR DELETE ON payouts FOR EACH ROW EXECUTE FUNCTION refuse_change();

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_type_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_type_check
  CHECK (type IN ('CONTRIBUTION_DUE', 'PAYMENT', 'FINE', 'UNUSED_FINE_POOL', 'REFUND', 'CORRECTION', 'PRIZE', 'YEAR_END_TRANSFER', 'PAYOUT'));
ALTER TABLE ledger_lines DROP CONSTRAINT ledger_lines_account_check;
ALTER TABLE ledger_lines ADD CONSTRAINT ledger_lines_account_check
  CHECK (account ~ '^(CASH|MAIN_POOL|YEAR_END_POOL|RECEIVABLE:\d+|REFUND_DUE:\d+|PRIZE_DUE:\d+|FINE_POOL:\d+:\d+)$');
