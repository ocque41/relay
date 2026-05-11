# AGENTS.md

AI-agent instructions for Cumulus Relay.

## Mission

Help maintain an open-source, self-hostable agent signup and action platform.
The repository should be understandable to outside contributors and safe to
publish.

## First Files To Read

1. `README.md` for product shape and setup.
2. `SELF_HOSTING.md` for deployment and env.
3. `CLAUDE.md` for architecture and engineering rules.
4. `docs/project-brief.md` for a deeper architecture tour.

## Rules

- Do not commit secrets, private notes, personal filesystem paths, or local
  agent artifacts.
- Do not add docs that only make sense for one person's machine.
- Keep hosted Cumulus Cloud and self-hosted Cumulus Relay paths clear.
- Preserve AGPL source availability for the full app/server.
- Preserve MIT package licenses for packages that already ship their own
  license files.
- Prefer small, direct changes with tests.

## Verification

Run the relevant subset, and for release work run all of:

```bash
npm run typecheck
npm run test
npm run build
```
