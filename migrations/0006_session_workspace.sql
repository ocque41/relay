-- Persist active workspace on the session row. The JWT cookie
-- continues to carry sub+jti only; the workspace is looked up server-side
-- so /v1/session/workspace can change it without re-issuing the cookie.

ALTER TABLE "sessions" ADD COLUMN "active_workspace" jsonb;
