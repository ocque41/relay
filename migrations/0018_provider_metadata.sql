-- 0018_provider_metadata.sql
--
-- Provider discoverability: make tenant-defined providers describable the same
-- way built-ins are. Every column is nullable/default '' so existing rows stay
-- valid without a backfill — integrators can fill these in at any time via the
-- dashboard's AddProvider form.

ALTER TABLE tenant_providers
  ADD COLUMN IF NOT EXISTS description  text,
  ADD COLUMN IF NOT EXISTS docs_url     text,
  ADD COLUMN IF NOT EXISTS homepage     text,
  ADD COLUMN IF NOT EXISTS npm_package  text,
  ADD COLUMN IF NOT EXISTS categories   jsonb NOT NULL DEFAULT '[]'::jsonb;
