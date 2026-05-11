# User Workspaces

User workspaces let one person keep separate Relay contexts. Each workspace has
its own accounts, signup jobs, inbox alias, agent tokens, and share links.

Developer workspaces are separate. They represent a product or startup that
integrates Relay. User workspaces represent the end-user side.

## Rules

- A user always has at least one personal workspace.
- One workspace is the default.
- A session stores whether the user is acting as a personal user or as a
  developer tenant.
- User-scoped agent tokens are pinned to the workspace where they were created.
- A token minted in one workspace cannot read another workspace.

## Schema

The main table is `user_workspaces`.

Important workspace-scoped tables include:

- `accounts`
- `signup_jobs`
- `email_messages`
- `magic_links`
- `audit_log`
- `agents`

Workspace scoping is enforced by `user_workspace_id` joins in REST routes, MCP
tools, and dashboard queries.

## Email Routing

Each workspace can have an inbox alias under `CATCHALL_DOMAIN`.

Inbound email routing tries:

1. signup aliases for waiting verification workflows
2. `user_workspaces.inbox_alias`
3. legacy user-level alias fallback

Matched email is stored in `email_messages` with the workspace id.

## API

User workspace routes:

```text
GET    /v1/user/workspaces
POST   /v1/user/workspaces
POST   /v1/user/workspaces/:id/rename
POST   /v1/user/workspaces/:id/switch
DELETE /v1/user/workspaces/:id
```

Delete protection:

- the workspace must belong to the caller
- the default workspace cannot be deleted
- the last remaining workspace cannot be deleted
- the request must confirm the exact workspace name

## CLI

The CLI exposes personal workspace commands:

```bash
relay workspaces list
relay workspaces create "Client A"
relay workspaces rename client-a "Client Alpha"
relay workspaces switch client-a
relay workspaces delete client-a
```

Bearer tokens remain pinned. After switching workspaces, mint a new token if
the agent should operate inside the new workspace.

## Tests

Workspace behavior is covered by:

- [src/server/user-workspaces.test.ts](../src/server/user-workspaces.test.ts)
- [src/server/routes/user-workspaces.test.ts](../src/server/routes/user-workspaces.test.ts)
