# Publishing npm Packages

Cumulus Relay publishes small MIT-licensed integration packages alongside the
AGPL server:

| Package | Path | Purpose |
| --- | --- | --- |
| `create-cumulus` | `packages/create-cumulus` | project creator |
| `@cumulus/cli` | `packages/cli` | hosted Relay CLI |
| `@cumulus/server` | `packages/server-sdk` | webhook/action helper SDK |
| `@cumulus/track` | `packages/track-sdk` | activation tracking helper |

Only publish from a clean worktree after tests pass.

## Authenticate

Use an npm account or automation token that has publish rights for the package:

```bash
npm login
npm whoami
```

For automation:

```bash
npm config set //registry.npmjs.org/:_authToken "$NPM_TOKEN"
```

Do not commit `.npmrc` files or tokens.

## Build and Publish

From each package directory:

```bash
npm run typecheck
npm run test --if-present
npm run build
npm publish --access public
```

The package `prepublishOnly` hooks run tests or builds again where configured.

For the creator package:

```bash
cd packages/create-cumulus
npm run typecheck
npm run test
npm run build
npm publish --access public
```

## Smoke Test

After publishing `create-cumulus`:

```bash
npm view create-cumulus@latest version
npx --yes create-cumulus@latest /tmp/cumulus-smoke \
  --template agent-auth \
  --agent-auth hosted \
  --no-install \
  --no-git
test -f /tmp/cumulus-smoke/app/api/relay-login/route.ts
```

`npm create cumulus@latest` is npm shorthand. It resolves to the
`create-cumulus` package:

```bash
npm create cumulus@latest /tmp/cumulus-smoke -- \
  --template outer \
  --agent-auth hosted \
  --no-install \
  --no-git
```

## Versioning

Use semver. Patch releases are for fixes and docs, minor releases for new
commands/templates, and major releases for breaking template or SDK changes.

```bash
cd packages/create-cumulus
npm version patch
npm publish --access public
```

Push the git tag created by `npm version` after the release commit is ready.
