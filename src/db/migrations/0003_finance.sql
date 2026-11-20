-- 0003_finance: the money ledger, manual UPI payments, payment details (QR / UPI ID), refund proposals.
-- Money is integer paise. The ledger is double-entry: every transaction's lines add up to zero (checked by the
-- database at commit). Like the points ledger it is append-only and derived entries are reconciled: a correction is
-- a REVERSAL, never an edit. Balances are always sums of lines - there are no stored totals to drift.
-- Accounts: CASH (money received, outside the app), RECEIVABLE:<p> (owed by a participant), MAIN_POOL (prize pool),
-- FINE_POOL:<p>:<week>, YEAR_END_POOL, REFUND_DUE:<p> (owed back to a participant).

CREATE TABLE ledger_transactions (
  transaction_id  bigserial PRIMARY KEY,
  challenge_id    bigint NOT NULL REFERENCES challenges(challenge_id),
  participant_id  bigint REFERENCES participants(participant_id),
  period_no       int,
  base_key        text NOT NULL,
  idem_key        text NOT NULL UNIQUE,
  type            text NOT NULL CHECK (type IN ('CONTRIBUTION_DUE', 'PAYMENT', 'FINE', 'UNUSED_FINE_POOL', 'REFUND', 'CORRECTION')),
  kind            text NOT NULL CHECK (kind IN ('ENTRY', 'REVERSAL')),
  reverses_transaction_id bigint REFERENCES ledger_transactions(transaction_id),
  day             date,
  origin          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- what caused it (missed day, payment id, refund id ...)
  actor_user_id   bigint REFERENCES users(user_id),
  created_at      timestamptz NOT NULL,
  CHECK ((kind = 'REVERSAL') = (reverses_transaction_id IS NOT NULL))
);
CREATE INDEX ledger_transactions_challenge ON ledger_transactions (challenge_id, base_key);

CREATE TABLE ledger_lines (
  line_id        bigserial PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES ledger_transactions(transaction_id),
  account        text NOT NULL CHECK (account ~ '^(CASH|MAIN_POOL|YEAR_END_POOL|RECEIVABLE:\d+|REFUND_DUE:\d+|FINE_POOL:\d+:\d+)$'),
  amount_paise   bigint NOT NULL CHECK (amount_paise <> 0)  -- debit positive, credit negative
);
CREATE INDEX ledger_lines_tx ON ledger_lines (transaction_id);
CREATE INDEX ledger_lines_account ON ledger_lines (account);

CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER ledger_lines_append_only BEFORE UPDATE OR DELETE ON ledger_lines FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions FOR EACH STATEMENT EXECUTE FUNCTION refuse_change();
CREATE TRIGGER ledger_lines_no_truncate BEFORE TRUNCATE ON ledger_lines FOR EACH STATEMENT EXECUTE FUNCTION refuse_change();

-- Every transaction balances (checked when the transaction commits, after all its lines are in).
CREATE FUNCTION ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total bigint; n int;
BEGIN
  SELECT coalesce(sum(amount_paise), 0), count(*) INTO total, n FROM ledger_lines WHERE transaction_id = NEW.transaction_id;
  IF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (% lines, total %)', NEW.transaction_id, n, total USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_transaction_balances AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_balanced();

-- Where participants pay (set by a Finance Admin; never in code).
CREATE TABLE payment_settings (
  challenge_id  bigint PRIMARY KEY REFERENCES challenges(challenge_id),
  upi_id        text CHECK (upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$'),
  payee_name    text CHECK (length(payee_name) <= 80),
  qr_file_id    bigint REFERENCES files(file_id),
  updated_by    bigint NOT NULL REFERENCES users(user_id),
  updated_at    timestamptz NOT NULL
);

-- A payment made outside the app (UPI), reported with its UTR and confirmed by a Finance Admin.
CREATE TABLE payments (
  payment_id     bigserial PRIMARY KEY,
  challenge_id   bigint NOT NULL REFERENCES challenges(challenge_id),
  participant_id bigint NOT NULL REFERENCES participants(participant_id),
  period_no      int NOT NULL,
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  method         text NOT NULL CHECK (method IN ('UPI', 'CASH', 'BANK_TRANSFER', 'OTHER')),
  utr            text CHECK (utr ~ '^[A-Za-z0-9]{6,30}$'),
  paid_on        date NOT NULL,
  proof_file_id  bigint REFERENCES files(file_id),
  note           text CHECK (length(note) <= 500),
  status         text NOT NULL CHECK (status IN ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'WITHDRAWN')),
  submitted_by   bigint NOT NULL REFERENCES users(user_id),
  submitted_at   timestamptz NOT NULL,
  decided_by     bigint REFERENCES users(user_id),
  decided_at     timestamptz,
  decision_reason text,
  updated_at     timestamptz NOT NULL
);
-- The same UTR can't be used twice in a challenge (unless the earlier one was rejected or withdrawn).
CREATE UNIQUE INDEX payments_utr_once ON payments (challenge_id, upper(utr)) WHERE utr IS NOT NULL AND status IN ('SUBMITTED', 'CONFIRMED');
CREATE INDEX payments_challenge ON payments (challenge_id, status);

-- Refunds (e.g. on withdrawal): proposed by a Finance Admin, approved by a Super Admin, then posted to the ledger.
CREATE TABLE refund_proposals (
  refund_id      bigserial PRIMARY KEY,
  challenge_id   bigint NOT NULL REFERENCES challenges(challenge_id),
  participant_id bigint NOT NULL REFERENCES participants(participant_id),
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  status         text NOT NULL CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED')),
  proposed_by    bigint NOT NULL REFERENCES users(user_id),
  proposed_at    timestamptz NOT NULL,
  decided_by     bigint REFERENCES users(user_id),
  decided_at     timestamptz,
  decision_reason text
);

ALTER TABLE files DROP CONSTRAINT files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check CHECK (purpose IN ('STEP_EVIDENCE', 'EXEMPTION_EVIDENCE', 'BONUS_EVIDENCE', 'PAYMENT_PROOF', 'PAYMENT_QR'));
