-- VI Iraq – social intelligence: what short social videos that perform well look like.
-- One row per analysed trending video (public link watched by Gemini through the official API – nothing downloaded –
-- or, later, the studio's own reels with their insights): the hook of the first seconds, cuts and pace, on-screen
-- text, what is said, the look, what keeps people watching, and the engagement numbers. The Reel Director (reels.js)
-- writes hooks, scripts and shot lists from the patterns that hold viewers. Idempotent.

CREATE TABLE IF NOT EXISTS reel_patterns (
  id            TEXT PRIMARY KEY,                 -- youtube:<id> | instagram:<media id>
  source        TEXT NOT NULL DEFAULT 'youtube',
  region        TEXT,
  kind          TEXT,                             -- People & vlogs, Comedy, How-to …
  title         TEXT NOT NULL DEFAULT '',
  url           TEXT,
  duration_sec  REAL NOT NULL DEFAULT 0,
  views         BIGINT NOT NULL DEFAULT 0,
  likes         BIGINT NOT NULL DEFAULT 0,
  comments      BIGINT NOT NULL DEFAULT 0,
  strength      REAL NOT NULL DEFAULT 0,          -- one number for "how well it performed" (reach + like rate)
  pattern       JSONB NOT NULL,                   -- hook{seconds,type,visual,words,text}, cuts, pace, captions, transcript, style, retention, concept
  embedding     REAL[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reel_patterns_strength_idx ON reel_patterns (strength DESC);
