import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { SessionUser } from './session';
import {
  requireTenantWorkspace,
  requireUserWorkspace,
  type WorkspaceEnv,
} from './workspace';

function appWith(session: SessionUser | undefined) {
  const app = new Hono<WorkspaceEnv>();
  app.use('*', async (c, next) => {
    if (session) c.set('session', session);
    await next();
  });
  return app;
}

function makeSession(
  overrides: { userId?: string; email?: string; workspace: SessionUser['activeWorkspace'] },
): SessionUser {
  return {
    userId: overrides.userId ?? 'user_a',
    email: overrides.email ?? 'a@example.com',
    sessionJti: 'jti_test',
    activeWorkspace: overrides.workspace,
  };
}

describe('workspace guards — cross-tenant isolation', () => {
  it('requireTenantWorkspace returns 401 with no session', async () => {
    const app = appWith(undefined);
    app.use('*', requireTenantWorkspace);
    app.get('/protected', (c) => c.json({ ok: true }));
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
  });

  it('requireTenantWorkspace returns 403 when the session is on the user workspace', async () => {
    const app = appWith(makeSession({ workspace: { kind: 'user' } }));
    app.use('*', requireTenantWorkspace);
    app.get('/protected', (c) => c.json({ ok: true }));
    const res = await app.request('/protected');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; expected?: string };
    expect(body.error).toBe('workspace_mismatch');
    expect(body.expected).toBe('tenant');
  });

  it('requireTenantWorkspace accepts a tenant-workspace session and sets activeTenantId', async () => {
    const app = appWith(
      makeSession({
        userId: 'user_owner',
        workspace: { kind: 'tenant', tenantId: 'tenant_allowed' },
      }),
    );
    app.use('*', requireTenantWorkspace);
    app.get('/protected', (c) =>
      c.json({
        activeTenantId: c.get('activeTenantId') ?? null,
        activeUserId: c.get('activeUserId') ?? null,
      }),
    );
    const res = await app.request('/protected');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activeTenantId: string; activeUserId: string };
    expect(body.activeTenantId).toBe('tenant_allowed');
    expect(body.activeUserId).toBe('user_owner');
  });

  it('requireUserWorkspace rejects sessions currently acting as a tenant', async () => {
    const app = appWith(
      makeSession({
        workspace: { kind: 'tenant', tenantId: 'tenant_x' },
      }),
    );
    app.use('*', requireUserWorkspace);
    app.get('/my-stuff', (c) => c.json({ ok: true }));
    const res = await app.request('/my-stuff');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('workspace_mismatch');
  });

  it('requireUserWorkspace accepts a user-workspace session', async () => {
    const app = appWith(makeSession({ workspace: { kind: 'user' } }));
    app.use('*', requireUserWorkspace);
    app.get('/my-stuff', (c) => c.json({ ok: true }));
    const res = await app.request('/my-stuff');
    expect(res.status).toBe(200);
  });
});
