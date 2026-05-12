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
npx create-cumulus@latest my-acme --template agent-auth --cumulus-db cloud
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

## Cumulus DB

Generated `full`, `inner`, and `agent-auth` projects include Cumulus DB
workspace support. Cumulus DB is separate from Relay Postgres:

- Relay Postgres uses `DATABASE_URL` for users, sessions, tenants, signup jobs,
  and API-key bookkeeping.
- Cumulus DB stores agent workspace records, key-value data, secrets, and search
  data through a separate HTTP service.

Generated `full` and `inner` projects include the local Relay
database/session stack even when `--agent-auth hosted` and `--cumulus-db cloud`
are selected. They are AGPL-3.0-only because that broader Relay stack is
included. Small hosted `agent-auth --cumulus-db cloud` projects stay MIT.

Relay Postgres supports hosted Neon HTTP and normal local Postgres. Leave
`DATABASE_DRIVER` blank for auto-detection. Localhost URLs use the `postgres`
driver; hosted URLs use Neon HTTP. Set `DATABASE_DRIVER=postgres` or
`DATABASE_DRIVER=neon-http` when you need to force one.

Modes:

| Mode | Meaning |
| --- | --- |
| `cloud` | Use hosted Cumulus DB through hosted Relay/Cumulus Cloud. |
| `local` | Include `apps/cumulus-db` and run the AGPL Cumulus DB service locally. |
| `both` | Include the local service and keep the hosted path documented. |

Defaults:

- `full`, `inner`, and `agent-auth` default to `both`.
- `outer` defaults to `cloud` and does not get local DB files or DB UI unless
  you explicitly choose a local DB mode.

The local Cumulus DB service is AGPL-3.0-only. Generated projects that include
it default to AGPL-3.0-only. Small hosted `agent-auth --cumulus-db cloud`
projects stay MIT.

Local DB projects include these scripts:

```bash
npm run cumulus-db:build
npm run cumulus-db:start
npm run cumulus-db:test
npm run cumulus-db:smoke
npm run cumulus-db:workspace
```

The generated `.env.example` includes these Cumulus DB settings when the local
service is present:

```bash
CUMULUS_DB_PUBLIC_URL=http://localhost:4317
CUMULUS_DB_INTERNAL_URL=http://localhost:4317
CUMULUS_DB_MASTER_KEY=replace-with-32-byte-base64-key
CUMULUS_DB_RELAY_WEBHOOK_SECRET=replace-with-relay-tenant-webhook-secret
CUMULUS_DB_DATA_DIR=.cumulus-db-data
CUMULUS_DB_PORT=4317
```

Use a persistent disk for `CUMULUS_DB_DATA_DIR` in production. The local service
is useful for self-hosting, demos, and private development. Hosted Cumulus DB
needs cloud credentials from hosted Relay/Cumulus Cloud.

## Flags

```bash
create-cumulus <project-name>
  --template full|outer|inner|agent-auth
  --agent-auth hosted|self-hosted
  --cumulus-db cloud|local|both
  --company "Acme Inc"
  --package-manager npm|pnpm|yarn|bun
  --install | --no-install
  --git | --no-git
```

If flags are missing in a TTY, the CLI asks for them. In non-interactive
mode it defaults to `full`, `hosted`, `npm`, no install, and no git init.

`my-acme` and `my-cumulus-app` are treated as placeholder names. If you pass
one of those and provide `--company "Acme Inc"`, the generated folder and
package name are derived from the company name. Pass any other first argument
when you need an exact folder name.

## Licenses

The `create-cumulus` package is MIT-licensed.

Generated `full`, `inner`, and self-hosted templates include the Relay app and
server and default to AGPL-3.0-only. Small hosted `outer` and `agent-auth`
templates default to MIT unless they include local Cumulus DB.

Cloud-only does not always mean MIT. `full` and `inner` still include the
AGPL-covered Relay dashboard/server pieces, so they remain AGPL-3.0-only even
when they point at hosted Cumulus DB.

Generated public app code talks to Cumulus DB over HTTP/token APIs. It does not
import source from `apps/cumulus-db`.
