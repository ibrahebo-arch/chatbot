-- VI Iraq – initial schema. Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS requesters (
  id                 TEXT PRIMARY KEY,                       -- requester_id = "<telegram>-<phone digits>"
  telegram_username  TEXT NOT NULL CHECK (telegram_username ~ '^[a-z0-9_]{5,32}$'),
  phone              TEXT NOT NULL CHECK (phone ~ '^\+9647[0-9]{9}$'),
  telegram_chat_id   BIGINT,                                 -- set when /start <id> links the chat
  telegram_linked_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_username, phone)
);
CREATE INDEX IF NOT EXISTS requesters_phone_idx ON requesters (phone);

CREATE TABLE IF NOT EXISTS orders (
  request_id      TEXT PRIMARY KEY,                          -- ticket id, e.g. VI-261012-K3F9
  requester_id    TEXT NOT NULL REFERENCES requesters(id),
  idempotency_key TEXT UNIQUE,                               -- a retry / double click returns the same order
  access_token    TEXT NOT NULL,                             -- random secret the customer's browser shows to read its own order
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','awaiting_admin','prompt_ready','generating','completed','delivered','failed','cancelled')),
  options         JSONB NOT NULL DEFAULT '{}',               -- quality, seconds, language, characters, price, description
  brief_md        TEXT,                                      -- production brief (replaces the files in D:\VI-Iraq)
  final_prompt    TEXT,                                      -- prompt sent to the video provider
  messages        JSONB NOT NULL DEFAULT '[]',               -- chat transcript for this order
  provider        TEXT DEFAULT 'higgsfield',
  provider_job_id TEXT,
  video_key       TEXT,                                      -- R2 key of the finished video
  error           TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS orders_requester_created_idx ON orders (requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

CREATE TABLE IF NOT EXISTS assets (                          -- customer uploads (characters / reference)
  id           BIGSERIAL PRIMARY KEY,
  request_id   TEXT REFERENCES orders(request_id) ON DELETE CASCADE,  -- NULL while the chat is still a draft
  requester_id TEXT REFERENCES requesters(id),
  upload_id    TEXT UNIQUE NOT NULL,                         -- random id the browser uses to refer to the file
  role         TEXT NOT NULL CHECK (role IN ('character1','character2','character3','reference')),
  media_type   TEXT NOT NULL CHECK (media_type IN ('image','video')),
  mime         TEXT,
  original_name TEXT,
  r2_key       TEXT NOT NULL,
  size_bytes   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_request_idx ON assets (request_id);

CREATE TABLE IF NOT EXISTS events (                          -- audit trail per order
  id         BIGSERIAL PRIMARY KEY,
  request_id TEXT REFERENCES orders(request_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_request_idx ON events (request_id, created_at);

CREATE TABLE IF NOT EXISTS telegram_admins (                 -- chats registered with /admin <ADMIN_TOKEN>
  chat_id    BIGINT PRIMARY KEY,
  username   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_set_updated_at ON orders;
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
