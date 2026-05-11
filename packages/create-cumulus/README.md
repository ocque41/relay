# create-cumulus

Create a Cumulus app with Relay-ready agent authentication, signup, actions,
dashboards, and optional self-hosted API/MCP.

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
| `full` | Marketing site, dashboard, API starter, playground, Relay signup/actions. |
| `outer` | Public marketing/docs site plus agent discovery and signup/action bootstrap. |
| `inner` | Dashboard, `/me` workspace, settings, API starter, playground, agent auth/actions. |
| `agent-auth` | Smallest Relay discovery, attestation login, signup, and actions starter. |

Legacy aliases still work: `marketing` maps to `outer`, and `inside` maps to
`inner`.

## Agent Auth Modes

| Mode | Use when |
| --- | --- |
| `hosted` | You want Relay hosted auth, signup, and action dispatch. |
| `self-hosted` | You want the generated app to own a local Relay-style API/MCP surface. |

Hosted mode emits `/.well-known/relay.json`, `/api/relay-login`,
`/api/agent-signup`, `/api/actions`, and env examples for connecting to Relay.

Self-hosted mode additionally emits `/v1/*`, `/mcp`, `/.well-known/jwks.json`,
`/openapi.json`, a workflow placeholder, schema notes, and a first migration.

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

## License

MIT.
