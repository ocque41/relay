import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  // The existing server code (src/server, workflows) was written under Node16
  // module resolution, so every internal import uses explicit `.js` suffixes
  // that must resolve to `.ts` sources under Next.js's bundler. Teach both
  // webpack and Turbopack the alias.
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias as Record<string, string[]> | undefined),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs'],
    resolveAlias: {},
  },
  // The workflow package brings its own server-side deps (WDK runtime);
  // let Next.js leave them external rather than bundling.
  serverExternalPackages: ['workflow', '@workflow/next'],
};

export default withWorkflow(nextConfig);
