-- VI Iraq – prompt knowledge library: reality, physics, sounds, places, items, actions.
-- The planner adds the always-on core and the entries that match the customer's words to every plan request.
-- Rows with source='file' are synced from prompts/library/*.json at start; rows with source='db' are added by hand
-- (DBeaver / SQL) and are never overwritten. Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS prompt_library (
  id          TEXT PRIMARY KEY,                    -- e.g. place.basra, item.land-cruiser
  domain      TEXT NOT NULL,                       -- reality | human | sound | place | item | action | nature | animal | style
  names       TEXT[] NOT NULL DEFAULT '{}',        -- words that trigger it (Arabic and English); empty = only via "always"
  kinds       TEXT[] NOT NULL DEFAULT '{video,image}',
  always      BOOLEAN NOT NULL DEFAULT false,      -- part of the core added to every request of these kinds
  priority    INT NOT NULL DEFAULT 50,             -- higher first when the budget is tight
  body        TEXT NOT NULL,                       -- the instruction text given to the planner (English)
  source      TEXT NOT NULL DEFAULT 'db',          -- file | db | generated
  enabled     BOOLEAN NOT NULL DEFAULT true,
  uses        INT NOT NULL DEFAULT 0,              -- how many plans used it
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prompt_library_domain_idx ON prompt_library (domain);
