-- 0020_provider_comparison_metadata.sql
--
-- Extends tenant_providers with the comparison metadata agents need to pick
-- between providers inside a category: pricing model, pricing URL, a short
-- free-tier blurb, and a capabilities array (e.g. ['postgres','serverless']).
--
-- Built-in providers (neon / vercel / resend) carry these fields in code;
-- this migration makes the same shape available to tenant-registered products.
--
-- All columns are nullable or defaulted so existing rows stay valid without a
-- backfill. Integrators fill these in via the AddProvider form or the MCP
-- `register_tenant_product` tool.

ALTER TABLE tenant_providers
  ADD COLUMN IF NOT EXISTS pricing_model     text,
  ADD COLUMN IF NOT EXISTS pricing_url       text,
  ADD COLUMN IF NOT EXISTS free_tier_summary text,
  ADD COLUMN IF NOT EXISTS capabilities      jsonb NOT NULL DEFAULT '[]'::jsonb;
