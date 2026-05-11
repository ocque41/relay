import { describe, it, expect } from 'vitest';
import {
  agentGuideBearerRouter,
  agentGuideSessionRouter,
  MAX_GUIDE_BYTES,
} from './agent-guide';

describe('agent-guide cap', () => {
  it('is 64 KiB (65536 bytes)', () => {
    expect(MAX_GUIDE_BYTES).toBe(64 * 1024);
    expect(MAX_GUIDE_BYTES).toBe(65536);
  });
});

describe('agent-guide bearer endpoints', () => {
  it('GET /v1/agent-guide without Authorization → 401', async () => {
    const res = await agentGuideBearerRouter.request('/v1/agent-guide');
    expect(res.status).toBe(401);
  });

  it('PUT /v1/agent-guide without Authorization → 401', async () => {
    const res = await agentGuideBearerRouter.request('/v1/agent-guide', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('PUT with an oversized body still requires auth (not 413 without it)', async () => {
    const tooBig = 'x'.repeat(MAX_GUIDE_BYTES + 1);
    const res = await agentGuideBearerRouter.request('/v1/agent-guide', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: tooBig }),
    });
    // Auth runs before the size check, so no bearer → 401, not 413.
    expect(res.status).toBe(401);
  });
});

describe('agent-guide session endpoints', () => {
  it('GET /v1/me/agent-guide without cookie → 401', async () => {
    const res = await agentGuideSessionRouter.request('/v1/me/agent-guide');
    expect(res.status).toBe(401);
  });

  it('PUT /v1/me/agent-guide without cookie → 401', async () => {
    const res = await agentGuideSessionRouter.request('/v1/me/agent-guide', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(401);
  });
});
