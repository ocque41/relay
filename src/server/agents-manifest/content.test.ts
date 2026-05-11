import { describe, it, expect } from 'vitest';
import {
  renderAgentsMarkdown,
  renderLlmsTxt,
  renderLlmsFullTxt,
} from './content';

const BASE = 'https://relay.example.com';

describe('renderAgentsMarkdown', () => {
  it('substitutes the base URL into the body', () => {
    const body = renderAgentsMarkdown({ baseUrl: BASE });
    expect(body).toContain(`Base URL: \`${BASE}\``);
    expect(body).not.toContain('{{BASE}}');
  });

  it('names the bearer scheme and the zero-retention stance', () => {
    const body = renderAgentsMarkdown({ baseUrl: BASE });
    expect(body).toContain('Authorization: Bearer agt_');
    expect(body).toMatch(/zero[- ]retention/i);
  });

  it('appends an authenticated hint when given a guide hint', () => {
    const body = renderAgentsMarkdown({
      baseUrl: BASE,
      authenticatedUserGuideHint: { updatedAt: '2026-04-19T12:00:00Z' },
    });
    expect(body).toContain('2026-04-19T12:00:00Z');
    expect(body).toContain('/v1/agent-guide');
  });

  it('falls back to a "sign in" paragraph when unauthenticated', () => {
    const body = renderAgentsMarkdown({ baseUrl: BASE });
    expect(body).toMatch(/sign in|bearer token/i);
  });
});

describe('renderLlmsTxt', () => {
  it('links to /AGENTS.md, /openapi.json, /docs, /mcp', () => {
    const body = renderLlmsTxt({ baseUrl: BASE });
    expect(body).toContain(`${BASE}/AGENTS.md`);
    expect(body).toContain(`${BASE}/openapi.json`);
    expect(body).toContain(`${BASE}/docs`);
    expect(body).toContain(`${BASE}/mcp`);
  });

  it('has no unresolved placeholders', () => {
    const body = renderLlmsTxt({ baseUrl: BASE });
    expect(body).not.toContain('{{BASE}}');
  });
});

describe('renderLlmsFullTxt', () => {
  it('mirrors renderAgentsMarkdown output', () => {
    const md = renderAgentsMarkdown({ baseUrl: BASE });
    const full = renderLlmsFullTxt({ baseUrl: BASE });
    expect(full).toBe(md);
  });
});
