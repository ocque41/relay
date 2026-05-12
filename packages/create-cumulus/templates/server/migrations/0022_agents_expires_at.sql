-- 0022_agents_expires_at.sql
--
-- Agent-token expiry. Default expiry for new tokens is 30 days, enforced at
-- mint time in src/server/auth/mint-token.ts. NULL means "never expires" and
-- is only permitted when the human user explicitly opts in.
--
-- Existing rows are preserved (NULL = never) so backwards compat holds. The
-- auth middleware gained an `(expires_at IS NULL OR expires_at > now())`
-- filter in the same change; the new index keeps that filter cheap.
--
-- Idempotent — safe to re-apply.

BEGIN;

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamptz NULL;

CREATE INDEX IF NOT EXISTS "agents_expires_at_idx"
  ON "agents" ("expires_at")
  WHERE "expires_at" IS NOT NULL;

COMMIT;
