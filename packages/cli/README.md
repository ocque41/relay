# @cumulus/cli

CLI for [Relay](https://relay.cumulush.com) — agent-driven signup for any app.

## Install

```bash
npm i -g @cumulus/cli
# or:
npx @cumulus/cli <cmd>
```

## Auth

```bash
relay login       # sign in via your browser (device-code flow)
relay whoami      # current identity
relay logout      # remove ~/.relay/config.json
```

## Workspace

Relay has two workspaces under one login: your end-user workspace and any
developer tenants you own or belong to.

```bash
relay workspace list
relay workspace switch user            # end-user workspace
relay workspace switch <tenant-slug>   # developer workspace
```

## End-user commands

```bash
relay accounts [--provider <id>]       # third-party accounts your agents created
relay keys [--account <id>]            # bookkeeping for every issued key
relay signups [--status <s>]           # signup timeline
relay inbox [--limit N]                # recent verification emails
relay share [--ttl 10m] [--uses N]     # mint a read-only share link
```

## Developer commands (tenant workspace)

```bash
relay products                         # list tenant products + weekly counters
relay products show <slug>             # detail
relay products rotate <slug>           # rotate webhook secret (plaintext once)
relay stats                            # weekly status rollup
relay users                            # end-users who signed up via this tenant
relay logs [--limit N]                 # recent signup_jobs
relay scan <slug>                      # reachability + HTTPS + signature probe
```

## Scaffolding

```bash
relay init                             # drop app/api/agent-signup/route.ts into a Next.js project
```

## Flags

| Flag        | Purpose                                     |
|-------------|---------------------------------------------|
| `--json`    | Emit JSON on any command (for scripting)    |
| `--verbose` | Trace every HTTP request to stderr          |

## Env

| Variable           | Purpose                                            |
|--------------------|----------------------------------------------------|
| `RELAY_BASE_URL`   | Override the API host (default `https://relay.cumulush.com`) |

## Config file

Credentials live at `~/.relay/config.json` with mode `0600`:

```json
{
  "base_url": "https://relay.cumulush.com",
  "agent_token": "agt_…",
  "user": { "id": "…", "email": "…", "inbox_alias": "…" }
}
```

Run `relay logout` to remove it.

## License

MIT.
