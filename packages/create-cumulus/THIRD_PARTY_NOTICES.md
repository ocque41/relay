# Third-Party Notices

`create-cumulus` generates projects that depend on open-source packages such
as Next.js, React, TypeScript, Hono, Drizzle, and jose.

Generated apps receive their own `package.json`; dependency licenses are
resolved by the package manager used during install.

Bundled templates include Plus Jakarta Sans font files. The generated app keeps
those font files under the upstream font license.

The `create-cumulus` package is MIT-licensed. Generated `full`, `inner`, and
self-hosted app/server templates default to AGPL-3.0-only. Small hosted
integration templates default to MIT.

No private Cumulus or Relay production secrets are bundled in this package.
