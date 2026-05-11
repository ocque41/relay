import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.{test,spec}.ts', 'workflows/**/*.{test,spec}.ts'],
    exclude: ['node_modules', '.next', '.vercel', 'packages/**', 'examples/**'],
    // Stub env for modules that call neon(process.env.DATABASE_URL!) at
    // import time. Individual tests override as needed.
    env: {
      DATABASE_URL: 'postgres://stub:stub@localhost:5432/stub',
      MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
      SESSION_SECRET: 'test-session-secret-32-chars-long!',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
