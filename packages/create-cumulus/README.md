# create-cumulus

Create a Relay/Cumulus app with Relay-ready agent authentication, signup,
actions, dashboards, branded UI, and optional self-hosted API/MCP.

```bash
npx create-cumulus@latest my-acme

# Equivalent npm create shorthand
npm create cumulus@latest my-acme

# Non-interactive
npx create-cumulus@latest my-acme --template full --agent-auth hosted --company "Acme Inc"
npx create-cumulus@latest my-acme --template outer --agent-auth hosted
npx create-cumulus@latest my-acme --template inner --agent-auth hosted
npx create-cumulus@latest my-acme --template full --agent-auth self-hosted --no-install --no-git
```

`npm create cumulus@latest` is npm shorthand for `create-cumulus@latest`.
Both commands download the same package from npm and run its `create-cumulus`
binary. They work only after `create-cumulus` has been published to npm.

For local development before publishing:

```bash
npm run create-cumulus:build
node packages/create-cumulus/dist/index.js my-acme --template full --agent-auth hosted
```

## Templates

| Template | Includes |
| --- | --- |
| `full` | Relay public site, `/me`, `/dev`, dashboards, API/MCP, docs, auth, signup, and actions. |
| `outer` | Relay public marketing/docs site plus discovery, signup, and action bootstrap. |
| `inner` | Relay `/me` and `/dev` dashboards, settings, API/MCP, auth, and actions. |
| `agent-auth` | Smallest Relay-branded discovery, attestation login, signup, and actions starter. |

Legacy aliases still work: `marketing` maps to `outer`, and `inside` maps to
`inner`.

## Agent Auth Modes

| Mode | Use when |
| --- | --- |
| `hosted` | You want Relay hosted auth, signup, and action dispatch. |
| `self-hosted` | You want the generated app to own a local Relay-style API/MCP surface. |

Hosted mode emits `/.well-known/relay.json`, `/api/relay-login`,
`/api/agent-signup`, `/api/actions`, and env examples for connecting to Relay.

Self-hosted mode additionally emits the local Relay control plane: `/v1/*`,
`/mcp`, `/.well-known/jwks.json`, `/openapi.json`, workflows, Drizzle schema,
and migrations.

`full` and `inner` include the local Relay app/server surfaces because the real
Relay dashboards depend on the Relay database/session/server modules. In hosted
mode, their agent-facing bootstrap endpoints default to hosted Cumulus Cloud.

## Flags

```bash
create-cumulus <project-name>
  --template full|outer|inner|agent-auth
  --agent-auth hosted|self-hosted
  --company "Acme Inc"
  --package-manager npm|pnpm|yarn|bun
  --install | --no-install
  --git | --no-git
```

If flags are missing in a TTY, the CLI asks for them. In non-interactive
mode it defaults to `full`, `hosted`, `npm`, no install, and no git init.

## Licenses

The `create-cumulus` package is MIT-licensed.

Generated `full`, `inner`, and self-hosted templates include the Relay app and
server and default to AGPL-3.0-only. Small hosted `outer` and `agent-auth`
templates default to MIT.
