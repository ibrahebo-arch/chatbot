-- VI Iraq – free trial tickets: every free job gets a ticket number (FT-YYMMDD-XXXX) and a copy of
-- its picture/video kept on our storage, so the team can track each free result. Idempotent.

ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS ticket TEXT;
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS stored_key TEXT;     -- our copy, e.g. trial/FT-261016-AB12.mp4
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- tickets for jobs made before this migration
UPDATE trial_jobs
   SET ticket = 'FT-' || to_char(created_at, 'YYMMDD') || '-' || upper(substr(md5(id), 1, 4))
 WHERE ticket IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trial_jobs_ticket_idx ON trial_jobs (ticket);
