# Inbound Email

Relay uses inbound email for agent-readable inboxes and verification flows.
When a provider sends a confirmation email, Relay can receive it, store it in
`email_messages`, and resume the waiting signup workflow.

The default implementation uses SendGrid Inbound Parse. You can replace it with
another provider by implementing the same route contract.

## Route

Inbound mail is accepted at:

```text
POST /v1/webhooks/email?secret=$EMAIL_SENDGRID_SECRET
```

The route is implemented in
[src/server/routes/email-webhook.ts](../src/server/routes/email-webhook.ts).

Relay expects SendGrid's `multipart/form-data` payload. It reads fields such as
`to`, `from`, `subject`, `text`, `html`, `headers`, and `envelope`.

## Domain Setup

Choose an inbox subdomain, for example:

```text
inbox.example.com
```

Add an MX record:

| Type | Name | Priority | Target |
| --- | --- | ---: | --- |
| MX | `inbox` | 10 | `mx.sendgrid.net.` |

Then configure SendGrid Inbound Parse:

- Receiving domain: `inbox.example.com`
- Destination URL: `https://your-relay-host.example.com/v1/webhooks/email?secret=<secret>`
- Raw MIME: optional
- Spam check: recommended

Set the same secret in your Relay environment:

```bash
EMAIL_SENDGRID_SECRET="$(openssl rand -hex 32)"
CATCHALL_DOMAIN="inbox.example.com"
```

## Local Test

Run the local webhook test:

```bash
EMAIL_SENDGRID_SECRET=test-secret npx tsx scripts/test-email-webhook.ts
```

For a deployed service, send a real email to an alias under your inbox domain
and verify it lands in `email_messages`:

```bash
psql "$DATABASE_URL" -c \
  "select to_address, from_address, subject, created_at from email_messages order by created_at desc limit 5;"
```

## Matching Rules

Relay uses the recipient local part to decide what to do:

- a signup alias resumes the matching durable signup workflow
- a user inbox alias stores the message for MCP `read_inbox`
- an unknown alias is stored only if the route can safely associate it

Keep `CATCHALL_DOMAIN` aligned with the domain configured in your email
provider.

## Rotate the Secret

1. Generate a new `EMAIL_SENDGRID_SECRET`.
2. Update the SendGrid destination URL.
3. Update the Relay environment variable.
4. Redeploy Relay.

Update SendGrid first. A short period of rejected email is safer than accepting
unsigned webhook calls.
