-- VI Iraq – automatic quality check of free videos: the verdicts, and whether the video was made a second time.
-- Idempotent: safe to run more than once.
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS qa JSONB;                          -- [{score, issues, model, at}], one per check
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS qa_retries INT NOT NULL DEFAULT 0;  -- how many times it was remade after a failed check
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS image_first_frame BOOLEAN;          -- started from a picture (cannot be remade the same way)
