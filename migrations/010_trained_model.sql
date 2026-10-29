-- VI Iraq – "Trained Model": keeps studying real footage and trends; every study is recorded, its draft library
-- entries wait for a review before they reach prompt_library (source='trained'). Idempotent.

CREATE TABLE IF NOT EXISTS trained_trends (
  id        BIGSERIAL PRIMARY KEY,
  source    TEXT NOT NULL,                 -- google-trends | youtube
  region    TEXT,                          -- IQ, SA, …
  topic     TEXT NOT NULL,
  traffic   TEXT,
  info      JSONB NOT NULL DEFAULT '{}',   -- news titles / tags that came with it
  seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trained_trends_seen_idx ON trained_trends (seen_at DESC);

CREATE TABLE IF NOT EXISTS trained_videos (
  id            TEXT PRIMARY KEY,          -- commons:<pageid> | pexels:<id>
  source        TEXT NOT NULL,
  query         TEXT,                      -- the footage search that found it
  trend         TEXT,                      -- the trend it was studied for (empty = realism basics)
  title         TEXT,
  page_url      TEXT,
  media_url     TEXT,
  license       TEXT,
  author        TEXT,
  duration_sec  REAL,
  status        TEXT NOT NULL DEFAULT 'new',   -- new | studied | failed
  score         REAL,                      -- how much the clip teaches about reality (0–10)
  check_result  JSONB,                     -- the reality check: what makes it real, what AI usually gets wrong
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  studied_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS trained_videos_status_idx ON trained_videos (status, created_at DESC);

CREATE TABLE IF NOT EXISTS trained_candidates (
  id           BIGSERIAL PRIMARY KEY,
  video_id     TEXT REFERENCES trained_videos(id) ON DELETE SET NULL,
  entry        JSONB NOT NULL,             -- {id, domain, names, kinds, priority, body}
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | duplicate
  note         TEXT,
  reviewer     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS trained_candidates_status_idx ON trained_candidates (status, created_at DESC);
