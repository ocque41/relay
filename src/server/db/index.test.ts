import { describe, expect, it } from 'vitest';
import { resolveDatabaseDriver } from './index';

describe('resolveDatabaseDriver', () => {
  it('uses postgres for local Postgres URLs', () => {
    expect(resolveDatabaseDriver('postgresql://user@127.0.0.1:55432/cumulus')).toBe('postgres');
    expect(resolveDatabaseDriver('postgresql://user@localhost:5432/cumulus')).toBe('postgres');
  });

  it('keeps hosted URLs on Neon HTTP by default', () => {
    expect(resolveDatabaseDriver('postgresql://user@example.neon.tech/cumulus')).toBe('neon-http');
  });

  it('lets DATABASE_DRIVER override auto-detection', () => {
    expect(resolveDatabaseDriver('postgresql://user@example.com/cumulus', 'postgres')).toBe('postgres');
    expect(resolveDatabaseDriver('postgresql://user@127.0.0.1:5432/cumulus', 'neon-http')).toBe('neon-http');
  });
});
