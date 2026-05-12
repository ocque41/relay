import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import type postgresFactory from 'postgres';
import * as schema from './schema';

type Database = ReturnType<typeof drizzleNeonHttp<typeof schema>>;
type DatabaseDriver = 'neon-http' | 'postgres';
type RuntimeRequire = (id: string) => unknown;

let cachedDb: Database | null = null;

function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveDatabaseDriver(url: string, configured = process.env.DATABASE_DRIVER): DatabaseDriver {
  const requested = envValue(configured)?.toLowerCase();
  if (requested === 'neon-http' || requested === 'postgres') return requested;

  const { hostname } = new URL(url);
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') {
    return 'postgres';
  }

  return 'neon-http';
}

function getRuntimeRequire(): RuntimeRequire {
  const runtimeRequire = Function('return typeof require === "function" ? require : undefined')() as
    | RuntimeRequire
    | undefined;
  if (!runtimeRequire) {
    throw new Error('DATABASE_DRIVER=postgres requires a Node.js server runtime with require().');
  }
  return runtimeRequire;
}

function createPostgresDb(url: string): Database {
  const runtimeRequire = getRuntimeRequire();
  const postgresClient = runtimeRequire('postgres') as typeof postgresFactory;
  const { drizzle } = runtimeRequire('drizzle-orm/postgres-js') as typeof import('drizzle-orm/postgres-js');

  return drizzle(postgresClient(url, { prepare: false }), { schema }) as unknown as Database;
}

export function getDb(): Database {
  if (cachedDb) return cachedDb;

  const url = envValue(process.env.DATABASE_URL);
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  if (resolveDatabaseDriver(url) === 'postgres') {
    cachedDb = createPostgresDb(url);
  } else {
    cachedDb = drizzleNeonHttp(neon(url), { schema });
  }
  return cachedDb;
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    const database = getDb();
    const value = Reflect.get(database as object, prop);
    return typeof value === 'function' ? value.bind(database) : value;
  },
});
