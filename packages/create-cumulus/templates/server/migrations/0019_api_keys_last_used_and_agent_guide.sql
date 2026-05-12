-- 0019_api_keys_last_used_and_agent_guide.sql
--
-- Two additive, nullable columns. No backfill needed — legacy rows treated as
-- "never used / no guide" by the route layer.
--
-- api_keys.last_used_at: Relay-observable usage timestamp. Bumped on mint,
-- signup delivery, legacy reveal, rotation, and Relay-initiated provider calls.
-- Does NOT reflect direct calls from the end-user's copy of the key against the
-- provider.
--
-- users.agent_guide + users.agent_guide_updated_at: per-user markdown memory
-- that the user's AI agents read at session start. 64 KiB cap enforced at the
-- route layer.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS agent_guide text,
  ADD COLUMN IF NOT EXISTS agent_guide_updated_at timestamptz;
