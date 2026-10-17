-- VI Iraq – voices: the customer's own recordings (checked before use) and the voice chosen for a free video.
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS voice_clips (
  id           TEXT PRIMARY KEY,                     -- random id, known only to the browser that recorded it
  ip_hash      TEXT NOT NULL,                        -- salted hash of the visitor's IP (never the IP itself)
  r2_key       TEXT NOT NULL,                        -- voices/clips/<id>.mp3 (converted to mono MP3)
  duration_sec NUMERIC(6, 2),
  transcript   TEXT,                                 -- the words heard in the recording
  lang         TEXT,                                 -- language detected by the transcription
  analysis     JSONB,                                -- loudness, noise, speaker gender/age, verdict items
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_clips_ip_idx ON voice_clips (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_clips_age_idx ON voice_clips (created_at);

-- the voice a free video used: { mode: tts|own|convert|none, preset, label, clip }
ALTER TABLE trial_jobs ADD COLUMN IF NOT EXISTS voice JSONB;
