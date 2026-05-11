-- Drop every user-wallet table & column.
--
-- Relay is pivoting to integrator-only revenue: end-users are free
-- (rate-limited), integrators pay a subscription with included signup quota
-- and per-signup overage. The user-facing token wallet, SPT autopay,
-- and scaffolded Stripe Issuing cards are all going away.
--
-- SAFETY: run scripts/verify-pre-0015.ts BEFORE this migration. It asserts
-- that no real charges exist (because BILLING_ENFORCEMENT has always been
-- `off` in prod, this should pass trivially). If it fails, stop and audit.
--
-- Rollback: scripts/rollback-0015.sql recreates the tables EMPTY — there is
-- no data to restore because enforcement was never flipped on.

-- 1. Drop the FK column on action_invocations before dropping usage_events.
--    The whole user-side charge/refund ledger is going away; action_invocations
--    keeps its status/latency/error fields for integrator-side analytics.
ALTER TABLE "action_invocations"
  DROP COLUMN IF EXISTS "charge_event_id";

-- 2. User wallet + ledger + price book.
DROP TABLE IF EXISTS "usage_events";
DROP TABLE IF EXISTS "token_balances";
DROP TABLE IF EXISTS "pricing_config";

-- 3. User-side Stripe autopay infrastructure (SPT + MPP receipts + Issuing cards).
DROP TABLE IF EXISTS "mpp_payments";
DROP TABLE IF EXISTS "user_shared_payment_tokens";
DROP TABLE IF EXISTS "user_issued_cards";

-- 4. The per-user free-action meter on users. Abuse prevention
--    replaces this with a per-month signup counter, keyed on a separate table.
ALTER TABLE "users"
  DROP COLUMN IF EXISTS "free_actions_remaining";
