# Security policy

## Reporting a vulnerability

Please report security issues by emailing **security@cumulush.com** or by
opening a GitHub Security Advisory. Do not open a public issue for a live
vulnerability.

Include:
- Affected endpoint / package / version
- Reproduction steps or a minimal PoC
- Impact assessment

We'll acknowledge within 48 hours and aim to patch critical issues within 7 days.

## In Scope

- **Auth bypass** on any `/v1/auth/*`, `/v1/me/*`, `/v1/signups/*`, `/v1/accounts/*`, `/v1/cli/*`, or `/mcp` route.
- **Cryptographic weaknesses** in `MASTER_KEY` encryption or `SESSION_SECRET` signing.
- **Data exposure** — leaking plaintext credentials, agent tokens, or user emails outside their owner.
- **Inbound email bypass** — accepting a POST to `/v1/webhooks/email` without a valid `?secret=$EMAIL_SENDGRID_SECRET`, or HMAC signature bypass on outbound tenant webhooks.
- **Cross-tenant access** — one tenant's agent seeing another tenant's data.
- **Session fixation or replay**.

## Not In Scope

- Rate-limit bypasses (the per-token limiter is a safety net, not a hard quota).
- Issues requiring physical access to a signed-in user's device.
- Clickjacking on endpoints that don't mutate state.
- Social engineering of users ("please paste your token here").

## Known design choices (not vulnerabilities)

- **Agent tokens** are stored as SHA-256 hashes; plaintext is shown once at mint and never again. This is intentional.
- **`EMAIL_SENDGRID_SECRET`** is a single query-param shared secret between SendGrid's Inbound Parse destination URL and Relay. Rotate it in both your deployment environment and SendGrid destination URL.
- **`/v1/cron/gc`** is unauthenticated by default — it only deletes expired rows and returns counts. Set `CRON_SECRET` to require `Authorization: Bearer`.
- **Agent inboxes** are readable by any valid agent token scoped to the user. Don't mint tokens you don't trust.
