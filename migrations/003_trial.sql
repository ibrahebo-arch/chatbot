-- VI Iraq – free trial: a few AI images / one short video per visitor IP, no account, no payment.
-- The IP is never stored, only a salted hash. Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS trial_jobs (
  id              TEXT PRIMARY KEY,                          -- random id, shown to the browser with a token
  token           TEXT NOT NULL,                             -- secret that lets only that browser read the job
  ip_hash         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  style           TEXT NOT NULL CHECK (style IN ('realistic', 'cartoon')),
  prompt          TEXT NOT NULL,                             -- what the visitor typed
  model_prompt    TEXT,                                      -- English prompt sent to the model
  source_job      TEXT REFERENCES trial_jobs(id) ON DELETE SET NULL,  -- "animate this image"
  provider        TEXT NOT NULL DEFAULT 'fal',
  model           TEXT NOT NULL,
  provider_job_id TEXT,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  result_url      TEXT,
  cost_usd        NUMERIC(8, 4) NOT NULL DEFAULT 0,          -- estimate, counted against the daily budget
  terms_sections  INT[],                                     -- terms shown to the visitor (not blocked)
  error           TEXT,
  checked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS trial_jobs_ip_idx ON trial_jobs (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS trial_jobs_open_idx ON trial_jobs (created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS trial_jobs_day_idx ON trial_jobs (created_at);
