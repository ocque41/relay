# Billing

Cumulus Relay bills the developer or startup that integrates Relay. End-users
do not pay Relay to let their agent sign up for products or call actions.

This document is safe to publish. It describes the default billing model used
by the hosted service and by self-hosted deployments.

## Model

Relay meters write actions:

- creating a signup
- minting, rotating, revealing, or deleting an API key
- invoking a registered action

Read-only calls are free:

- listing providers
- reading signup status
- reading account metadata
- reading audit logs

If an action fails after quota is reserved, Relay refunds the reserved quota
slot. Each write path uses an idempotency key so retries do not double-charge.

## Plans

Plan data lives in the `plan_catalog` table. Operators can change prices,
included actions, and overage amounts without code changes.

The default ladder is:

| Plan | Included actions | Intended user |
| --- | ---: | --- |
| Founders | trial pool | early evaluators |
| Builder | small monthly pool | solo builders |
| Starter | larger monthly pool | early teams |
| Growth | larger monthly pool | growing products |
| Scale | high-volume pool | production startups |
| Enterprise | custom | custom contracts |

Hosted Relay uses Stripe for checkout, subscriptions, invoices, and credit
packs. Self-hosted operators can keep Stripe, replace it, or turn enforcement
off while testing.

## Environment switches

| Env | Values | Default | Purpose |
| --- | --- | --- | --- |
| `BILLING_ENFORCEMENT` | `off`, `warn`, `enforce` | `off` | Master switch for quota enforcement |
| `BILLING_METER` | `signups`, `actions` | `actions` | Selects legacy signup-only or full action metering |
| `ABUSE_ENFORCEMENT` | `off`, `warn`, `enforce` | `warn` | Controls per-user and per-token abuse limits |

Recommended self-hosted rollout:

1. Start with `BILLING_ENFORCEMENT=off`.
2. Connect Stripe and verify webhook handling in test mode.
3. Move to `warn` and inspect logs.
4. Move to `enforce` only after successful checkout and webhook tests.

## Credit packs

Credit packs are prepaid action pools stored in `action_credits`.

Relay consumes quota in this order:

1. included plan actions
2. prepaid credits
3. metered overage
4. hard cap or rejection

Credit consumption is recorded in `action_credit_consumptions` so refunds can
restore the exact credit slot.

## Abuse controls

Relay has separate abuse controls so one end-user cannot drain a tenant quota:

| Layer | Storage | Purpose |
| --- | --- | --- |
| per-user monthly action cap | Postgres | protects tenant spend |
| per-token burst limit | process memory | reduces hot-loop abuse |
| per-key reveal limit | process memory | limits credential exposure |
| tenant pause switch | Postgres | operator kill switch |

The in-memory limits are intentionally simple. If you self-host at high scale,
move those counters to Redis, Upstash, or another shared store.

## Tables

Billing and quota state is stored in:

- `plan_catalog`
- `tenant_subscriptions`
- `subscription_events`
- `tenant_quota_state`
- `stripe_pending_invoice_items`
- `action_credits`
- `action_credit_consumptions`
- `user_action_counts`

See [src/server/db/schema.ts](../src/server/db/schema.ts) and
[migrations](../migrations) for the exact schema.
