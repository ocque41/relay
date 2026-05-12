-- 0021_user_workspaces.sql
--
-- Multiple personal workspaces per user. Lets a single Relay user operate
-- several independent buckets of accounts / API keys / inbox / signup history
-- from one login. Entirely separate from the existing tenant (developer)
-- workspace system — user workspaces are personal and never shared; tenants
-- are multi-seat integrator organisations with owner/member roles.
--
-- Architectural constraints:
--   1. Session JWT / cookie shape is NOT changed. Which user workspace is
--      currently active is stored on `users.active_user_workspace_id` and
--      resolved per-request from that column.
--   2. User-scoped agent tokens are pinned to a single user workspace at
--      creation time (same pattern as integrator tokens pinning to a
--      tenant). Column: `agents.user_workspace_id`.
--   3. Per-workspace inbox aliases. `user_workspaces.inbox_alias` is the new
--      source of truth; `users.inbox_alias` is kept populated for backward
--      compat during the transition.
--
-- Backfill strategy: every existing user gets exactly one "Default"
-- workspace that inherits their current `users.inbox_alias`. All existing
-- rows scoped by `user_id` are stamped with that default workspace's id.
-- Constraints are deferred (or added after backfill) so this works on live
-- data in one shot.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. user_workspaces — one row per personal workspace.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_workspaces (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  slug         text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  -- Each workspace owns its own inbox alias so verification emails for
  -- workspace A can never land in workspace B's inbox. Unique across the
  -- table so an incoming email webhook can resolve alias → workspace with
  -- one lookup.
  inbox_alias  text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Slug is unique *per user*, not globally.
CREATE UNIQUE INDEX IF NOT EXISTS user_workspaces_user_slug_key
  ON user_workspaces(user_id, slug);

-- Partial unique index: at most one is_default=true row per user.
-- New defaults are promoted by flipping the old one to false inside a
-- transaction first.
CREATE UNIQUE INDEX IF NOT EXISTS user_workspaces_one_default_per_user
  ON user_workspaces(user_id)
  WHERE is_default = true;

-- ---------------------------------------------------------------------------
-- 2. users.active_user_workspace_id — pointer to the currently-active
--    personal workspace. Nullable so app code can fall back to the
--    is_default row when unset.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active_user_workspace_id uuid
    REFERENCES user_workspaces(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3. Scope columns on every user-scoped table. Nullable so rows without a
--    `user_id` (integrator-scoped accounts, unmatched inbound emails, etc.)
--    stay valid. App-layer filtering enforces "user_id set ⇒ user_workspace_id
--    set" for freshly-inserted rows.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS user_workspace_id uuid
    REFERENCES user_workspaces(id) ON DELETE CASCADE;

ALTER TABLE signup_jobs
  ADD COLUMN IF NOT EXISTS user_workspace_id uuid
    REFERENCES user_workspaces(id) ON DELETE CASCADE;

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS user_workspace_id uuid
    REFERENCES user_workspaces(id) ON DELETE SET NULL;

ALTER TABLE magic_links
  ADD COLUMN IF NOT EXISTS user_workspace_id uuid
    REFERENCES user_workspaces(id) ON DELETE CASCADE;

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS user_workspace_id uuid
    REFERENCES user_workspaces(id) ON DELETE SET NULL;

-- agents.user_workspace_id — only populated for user-scoped agents
-- (user_id IS NOT NULL AND tenant_id IS NULL). Integrator-scoped agents
-- keep it null and continue to be scoped by tenant_id.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS user_workspace_id uuid
    REFERENCES user_workspaces(id) ON DELETE CASCADE;

-- Per-user monthly signup counter — kept per-USER (not per-workspace) so
-- the abuse gate is one-human-one-cap regardless of how many workspaces
-- the user spreads their signups across. No column added.

-- ---------------------------------------------------------------------------
-- 4. Backfill — every user gets exactly one "Default" workspace that
--    inherits their current inbox alias. Idempotent via NOT EXISTS guards.
-- ---------------------------------------------------------------------------
INSERT INTO user_workspaces (user_id, name, slug, is_default, inbox_alias)
SELECT u.id, 'Default', 'default', true, u.inbox_alias
FROM   users u
WHERE NOT EXISTS (
  SELECT 1 FROM user_workspaces w WHERE w.user_id = u.id
);

-- Point every user at their default workspace (for users that didn't
-- already have an active_user_workspace_id set).
UPDATE users u
SET    active_user_workspace_id = w.id
FROM   user_workspaces w
WHERE  w.user_id = u.id
  AND  w.is_default = true
  AND  u.active_user_workspace_id IS NULL;

-- Stamp every existing user-scoped row with that user's default workspace.
UPDATE accounts       a
SET    user_workspace_id = w.id
FROM   user_workspaces w
WHERE  w.user_id = a.user_id
  AND  w.is_default = true
  AND  a.user_id IS NOT NULL
  AND  a.user_workspace_id IS NULL;

UPDATE signup_jobs    s
SET    user_workspace_id = w.id
FROM   user_workspaces w
WHERE  w.user_id = s.user_id
  AND  w.is_default = true
  AND  s.user_id IS NOT NULL
  AND  s.user_workspace_id IS NULL;

UPDATE email_messages e
SET    user_workspace_id = w.id
FROM   user_workspaces w
WHERE  w.user_id = e.user_id
  AND  w.is_default = true
  AND  e.user_id IS NOT NULL
  AND  e.user_workspace_id IS NULL;

UPDATE magic_links    m
SET    user_workspace_id = w.id
FROM   user_workspaces w
WHERE  w.user_id = m.user_id
  AND  w.is_default = true
  AND  m.user_workspace_id IS NULL;

UPDATE audit_log      al
SET    user_workspace_id = w.id
FROM   user_workspaces w
WHERE  w.user_id = al.user_id
  AND  w.is_default = true
  AND  al.user_id IS NOT NULL
  AND  al.user_workspace_id IS NULL;

UPDATE agents         ag
SET    user_workspace_id = w.id
FROM   user_workspaces w
WHERE  w.user_id = ag.user_id
  AND  w.is_default = true
  AND  ag.user_id IS NOT NULL
  AND  ag.tenant_id IS NULL
  AND  ag.user_workspace_id IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Indexes that speed up the hot read paths.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS accounts_user_workspace_idx
  ON accounts(user_workspace_id) WHERE user_workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS signup_jobs_user_workspace_idx
  ON signup_jobs(user_workspace_id) WHERE user_workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_messages_user_workspace_idx
  ON email_messages(user_workspace_id) WHERE user_workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS magic_links_user_workspace_idx
  ON magic_links(user_workspace_id) WHERE user_workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_user_workspace_idx
  ON audit_log(user_workspace_id) WHERE user_workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agents_user_workspace_idx
  ON agents(user_workspace_id) WHERE user_workspace_id IS NOT NULL;

COMMIT;
