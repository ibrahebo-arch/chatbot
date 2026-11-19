-- VI Iraq – saved chats. A visitor's chats stay after a refresh or a later visit and can be opened again from the
-- history list. A chat belongs to a device id: a random 128-bit value the browser makes once and keeps in its own
-- storage (it survives a changing IP address; it is lost only when the visitor clears the site's data). No name,
-- phone or IP is stored here – only HMAC hashes of the IPs the device was seen from, so the studio can link a device's
-- free tickets and orders even when its IP changes. Chats are deleted after CHAT_KEEP_DAYS (90). Idempotent.

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,                    -- C + 20 random hex characters (made in the browser)
  device      TEXT NOT NULL,                       -- the browser's random device id
  title       TEXT NOT NULL DEFAULT '',
  mode        TEXT NOT NULL DEFAULT 'free',        -- free | order
  messages    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{role, content, files}]
  jobs        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- free results [{id, token, at}] (shown again with their token)
  order_ref   JSONB,                               -- {requestId, requesterId, accessToken, at}
  uploads     TEXT[] NOT NULL DEFAULT '{}',        -- upload ids used in the chat (kept while the chat is kept)
  tickets     TEXT[] NOT NULL DEFAULT '{}',
  ip_hashes   TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chats_device_idx ON chats (device, updated_at DESC);
CREATE INDEX IF NOT EXISTS chats_updated_idx ON chats (updated_at);
