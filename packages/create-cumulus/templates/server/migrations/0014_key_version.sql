-- MASTER_KEY rotation prep.
--
-- Every encrypted column gets a companion `key_version` smallint (default 1).
-- Key rotation uses this to select MASTER_KEY_V1 vs MASTER_KEY_V2
-- at decrypt time. Default 1 = all existing rows stay decryptable by the
-- current single MASTER_KEY env var.

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "key_version" smallint NOT NULL DEFAULT 1;

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "key_version" smallint NOT NULL DEFAULT 1;

ALTER TABLE "signup_jobs"
  ADD COLUMN IF NOT EXISTS "key_version" smallint NOT NULL DEFAULT 1;

ALTER TABLE "tenant_providers"
  ADD COLUMN IF NOT EXISTS "key_version" smallint NOT NULL DEFAULT 1;

ALTER TABLE "actions"
  ADD COLUMN IF NOT EXISTS "key_version" smallint NOT NULL DEFAULT 1;
