-- VI Iraq – free trial: spoken line (Iraqi/other language) and the structured prompt. Idempotent.
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS speech_text TEXT;        -- the words the character says
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS speech_lang TEXT;        -- ar-IQ, ar, en, ku, tr, fa …
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS audio_key  TEXT;         -- our copy of the voice track (mp3)
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS plan       JSONB;        -- full structured prompt (prompt, negative, shots, onScreenText)
