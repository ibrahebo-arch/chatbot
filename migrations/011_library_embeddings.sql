-- VI Iraq – prompt library: meaning vectors.
-- Each entry gets an embedding of its names + body, so a request can find the entries that belong to its scene even
-- when the customer did not type one of the names word for word. embed_sig = hash of model + size + text: when the
-- text changes, library.js makes a new vector. Idempotent: safe to run more than once.

ALTER TABLE prompt_library ADD COLUMN IF NOT EXISTS embedding REAL[];
ALTER TABLE prompt_library ADD COLUMN IF NOT EXISTS embed_sig TEXT;
