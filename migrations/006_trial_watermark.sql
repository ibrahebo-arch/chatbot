-- VI Iraq – free trial: every result carries the VI-Iraq mark. Idempotent.
--   raw_url      the provider's own (unstamped) result address; it is never shown to the visitor
--   watermarked  true once the stamped copy is stored – the only copy that is served
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS raw_url TEXT;
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS watermarked BOOLEAN NOT NULL DEFAULT false;
