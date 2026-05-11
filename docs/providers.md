# Providers

Providers are the products Relay can sign users up for or invoke actions on.
Examples include databases, hosting platforms, email services, auth providers,
storage, analytics, payments, AI APIs, and SaaS tools.

Relay supports two provider models:

- **built-in providers** operated by the Relay deployment
- **tenant providers** registered by a startup that wants agents to use its own
  product

## Discovery

The live provider list is exposed through every agent-facing surface:

- `GET /v1/providers`
- `GET /v1/providers/:id`
- `GET /v1/index`
- `GET /v1/index/:category`
- MCP `list_categories`
- MCP `list_providers_by_category`
- MCP `list_providers`
- CLI provider commands

Each provider can include:

- `id`
- `displayName`
- `description`
- `homepage`
- `docsUrl`
- `categories`
- `capabilities`
- `pricingModel`
- `pricingUrl`
- `freeTierSummary`
- `inputSchema`
- optional `npmPackage`

## Built-In Providers

Built-in providers live in [src/server/providers](../src/server/providers).
They are useful for a hosted Relay service because they let Relay provision
cloud resources directly.

Self-hosted operators should review these providers before launch. Keep the
ones you can legally and operationally support, remove the rest, or replace
them with providers that use your own cloud accounts.

## Tenant Providers

Tenant providers are registered by developers using Relay. They let an
external product become agent-ready without merging code into Relay.

A tenant provider supplies metadata, an input schema, and a webhook URL. Relay
sends HMAC-signed webhook calls to that URL when an agent starts a signup.

Webhook handlers should:

1. verify the HMAC signature
2. validate the requested input
3. create or find the user/account in the product
4. return account metadata and any one-time credentials

## Categories

Canonical categories live in
[src/server/providers/categories.ts](../src/server/providers/categories.ts).

The default vocabulary includes:

```text
database, hosting, email, newsletter, auth, storage, analytics, payments,
cms, observability, ai, search, saas
```

Category aliases help agents recover from fuzzy words such as `mail`,
`hoster`, or `logs`.

## Adding a Built-In Provider

1. Implement the `Provider<Input, Account>` interface in
   `src/server/providers/<id>.ts`.
2. Register it in `src/server/providers/index.ts`.
3. Add metadata, categories, capabilities, and input schema.
4. Add tests for success, provider failure, and credential handling.

Built-in providers run inside the Relay deployment. Treat them as privileged
code.

## Adding a Tenant Provider

Use the dashboard or API to register a provider for your tenant. The provider
will appear in discovery responses with `kind: "tenant"` and will dispatch to
your webhook.

Tenant providers are the preferred path for startups that want to connect
their product to hosted Relay.
