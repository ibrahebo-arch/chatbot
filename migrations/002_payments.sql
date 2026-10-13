-- VI Iraq – payments (Wayl payment links). Idempotent: safe to run more than once.
--
-- An order stays 'queued' (مسجّل) until a payment link of its own is confirmed paid by the
-- verification key; then orders.paid_at is set and the order moves on to review (مراجعة).
-- One order can have several links (an expired or cancelled link is replaced by a new one).

CREATE TABLE IF NOT EXISTS payments (
  id              BIGSERIAL PRIMARY KEY,
  request_id      TEXT NOT NULL REFERENCES orders(request_id) ON DELETE CASCADE,
  provider        TEXT NOT NULL DEFAULT 'wayl',
  reference_id    TEXT NOT NULL UNIQUE,                      -- our referenceId at Wayl, e.g. VI-261013-F5M4-P1
  provider_id     TEXT,                                      -- Wayl's link id
  url             TEXT,                                      -- checkout page for the customer
  env             TEXT NOT NULL DEFAULT 'test' CHECK (env IN ('test', 'live')),
  amount_iqd      INT NOT NULL CHECK (amount_iqd >= 1000),
  amount_usd      NUMERIC(10, 2),
  status          TEXT NOT NULL DEFAULT 'Created',           -- Wayl link status (Created, Pending, Processing, Complete, Delivered, Cancelled, Rejected, Returned)
  payment_method  TEXT,
  expires_at      TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  checked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_request_idx ON payments (request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_open_idx ON payments (created_at) WHERE paid_at IS NULL;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

DROP TRIGGER IF EXISTS payments_set_updated_at ON payments;
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
